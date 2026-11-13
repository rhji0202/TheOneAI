"""첨부 문서(XLSX · DOCX · PPTX · PDF)를 모델이 읽을 텍스트로 바꾸고, 표(XLSX · CSV)에 SQL 을 실행한다 — 표준 라이브러리만 쓴다.

    python extract_text.py <xlsx|docx|pptx|pdf> [--poppler DIR] [--max-bytes N] [--max-pdf-images N]
    python extract_text.py <xlsx|csv> --sql "SELECT ..." [--table NAME]   (표 질의: {tables, columns, rows, truncated})

파일 내용은 stdin 으로 받고 stdout 에 JSON {"text": str, "images": [{"mimeType", "data", "page"}]} 을 쓴다.
PDF 는 poppler 의 pdftotext · pdftoppm 이 필요하다. 텍스트가 없는(스캔한) 페이지는 PNG 로 그려 images 에 담는다.
읽을 수 없는 파일이면 stderr 에 이유를 한 줄로 쓰고 종료 코드 2.
"""

import argparse
import base64
import csv
import datetime as dt
import io
import itertools
import json
import os
import posixpath
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import zipfile
from xml.etree import ElementTree as ET

MAX_PARTS = 2000
MAX_ROWS = 5000
MAX_COLS = 256
PDF_EMPTY_PAGE_CHARS = 20
TOOL_TIMEOUT_SECONDS = 60

# 기본 제공 날짜 · 시간 서식 번호 (27~36 · 50~58 은 한중일 로캘의 날짜 서식)
DATE_FORMAT_IDS = (
    set(range(14, 23)) | set(range(27, 37)) | set(range(45, 48)) | set(range(50, 59))
)


class Unreadable(Exception):
    """읽을 수 없는 문서 — 이유는 모델에게 그대로 전달된다."""


def local(tag):
    return tag.rsplit("}", 1)[-1]


def children(element, name):
    return [c for c in element if local(c.tag) == name]


def descendants(element, name):
    return [c for c in element.iter() if local(c.tag) == name]


def relation_id(element):
    """r:id — 접두어 없는 id(슬라이드 번호 등)와 구분해 네임스페이스가 붙은 것만 읽는다."""
    for key, value in element.attrib.items():
        if key.startswith("{") and local(key) == "id":
            return value
    return ""


def open_package(data, max_bytes):
    try:
        package = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise Unreadable(f"not a valid Office file ({exc})")
    parts = package.infolist()
    if len(parts) > MAX_PARTS:
        raise Unreadable(f"too many parts in the file ({len(parts)})")
    # 압축 폭탄 — 선언된 크기만큼만 풀리므로(zipfile) 합계를 먼저 본다
    unpacked = sum(p.file_size for p in parts)
    if unpacked > max_bytes:
        raise Unreadable(f"unpacked size is too large ({unpacked} bytes, limit {max_bytes})")
    return package


def read_xml(package, name, optional=False):
    try:
        return ET.fromstring(package.read(name))
    except KeyError:
        if optional:
            return None
        raise Unreadable(f"missing {name}")
    except ET.ParseError as exc:
        if optional:
            return None
        raise Unreadable(f"malformed {name} ({exc})")


def relationships(package, name):
    root = read_xml(package, name, optional=True)
    if root is None:
        return {}
    return {r.get("Id"): r.get("Target", "") for r in descendants(root, "Relationship")}


def resolve_part(base_dir, target):
    if target.startswith("/"):
        return posixpath.normpath(target.lstrip("/"))
    return posixpath.normpath(posixpath.join(base_dir, target))


# ── XLSX ──────────────────────────────────────────────────────────────


def rich_text(item):
    """si · is 의 본문 — 후리가나 같은 보조 표기(rPh)는 뺀다."""
    out = []
    for child in item:
        if local(child.tag) == "t":
            out.append(child.text or "")
        elif local(child.tag) == "r":
            out.extend(t.text or "" for t in children(child, "t"))
    return "".join(out)


def is_date_format(code):
    # 따옴표 글자 · 이스케이프 · [색]/[$-로캘] 을 빼고 날짜 · 시간 기호가 남는지 본다
    cleaned = re.sub(r'"[^"]*"|\\.|\[[^\]]*\]', "", code)
    return bool(re.search(r"[ymdhs]", cleaned, re.IGNORECASE))


def date_styles(styles):
    if styles is None:
        return set()
    custom = {int(f.get("numFmtId", "-1")): f.get("formatCode", "") for f in descendants(styles, "numFmt")}
    xfs = next(iter(descendants(styles, "cellXfs")), None)
    found = set()
    for index, xf in enumerate(children(xfs, "xf") if xfs is not None else []):
        fmt = int(xf.get("numFmtId", "0"))
        if fmt in DATE_FORMAT_IDS or (fmt in custom and is_date_format(custom[fmt])):
            found.add(index)
    return found


def excel_date(serial, date1904):
    base = dt.datetime(1904, 1, 1) if date1904 else dt.datetime(1899, 12, 30)
    moment = base + dt.timedelta(seconds=round(serial * 86400))
    if 0 <= serial < 1:
        return moment.strftime("%H:%M:%S")
    if moment.time() == dt.time(0, 0):
        return moment.strftime("%Y-%m-%d")
    return moment.strftime("%Y-%m-%d %H:%M:%S")


def column_index(ref):
    letters = itertools.takewhile(str.isalpha, ref)
    index = 0
    for ch in letters:
        index = index * 26 + ord(ch.upper()) - ord("A") + 1
    return max(index - 1, 0)


def cell_value(cell, shared, dates, date1904):
    kind = cell.get("t", "n")
    value = next((v.text or "" for v in children(cell, "v")), "")
    if kind == "s":
        try:
            return shared[int(value)]
        except (ValueError, IndexError):
            return ""
    if kind == "inlineStr":
        inline = next(iter(children(cell, "is")), None)
        return "" if inline is None else rich_text(inline)
    if kind == "b":
        return "TRUE" if value.strip() in ("1", "true", "TRUE") else "FALSE"
    if kind == "e":
        return value or "#ERROR"
    if kind == "n" and value and cell.get("s", "").isdigit() and int(cell.get("s")) in dates:
        try:
            return excel_date(float(value), date1904)
        except (ValueError, OverflowError):
            return value
    return value


def sheet_rows(root, shared, dates, date1904):
    rows = []
    for row in itertools.islice(descendants(root, "row"), MAX_ROWS):
        cells = {}
        last = -1
        for cell in children(row, "c"):
            col = column_index(cell.get("r", "")) if cell.get("r") else last + 1
            if col < MAX_COLS:
                cells[col] = cell_value(cell, shared, dates, date1904)
                last = max(last, col)
        rows.append([cells.get(i, "") for i in range(last + 1)])
    while rows and not any(v.strip() for v in rows[-1]):
        rows.pop()
    return rows


def as_csv(rows):
    buffer = io.StringIO()
    csv.writer(buffer, lineterminator="\n").writerows(rows)
    return buffer.getvalue().rstrip("\n")


def xlsx_sheets(data, args):
    """보이는 시트마다 (이름, 행 목록)."""
    package = open_package(data, args.max_bytes)
    names = set(package.namelist())
    workbook = read_xml(package, "xl/workbook.xml")
    date1904 = any(p.get("date1904") in ("1", "true") for p in descendants(workbook, "workbookPr"))
    strings = read_xml(package, "xl/sharedStrings.xml", optional=True)
    shared = [rich_text(si) for si in descendants(strings, "si")] if strings is not None else []
    dates = date_styles(read_xml(package, "xl/styles.xml", optional=True))
    rels = relationships(package, "xl/_rels/workbook.xml.rels")
    sheets = []
    for sheet in descendants(workbook, "sheet"):
        if sheet.get("state") in ("hidden", "veryHidden"):
            continue
        part = resolve_part("xl", rels.get(relation_id(sheet), ""))
        if part not in names:
            continue
        root = read_xml(package, part, optional=True)
        if root is not None:
            sheets.append((sheet.get("name", "Sheet"), sheet_rows(root, shared, dates, date1904)))
    return sheets


def extract_xlsx(data, args):
    out = []
    for name, rows in xlsx_sheets(data, args):
        capped = " — first rows only" if len(rows) >= MAX_ROWS else ""
        out += [f'Sheet "{name}" ({len(rows)} rows{capped})', as_csv(rows), ""]
    text = "\n".join(out).rstrip("\n")
    if not text:
        raise Unreadable("the workbook has no visible sheets")
    return {"text": text, "images": []}


# ── DOCX ──────────────────────────────────────────────────────────────


def paragraph_text(paragraph):
    # w:rt 는 루비(윗주) 표기 — 본문이 아니다
    ruby = {n for rt in descendants(paragraph, "rt") for n in rt.iter()}
    out = []
    for node in paragraph.iter():
        if node in ruby:
            continue
        name = local(node.tag)
        if name == "t":
            out.append(node.text or "")
        elif name == "tab":
            out.append("\t")
        elif name in ("br", "cr"):
            out.append("\n")
    return "".join(out)


def docx_blocks(container, lines):
    for block in container:
        name = local(block.tag)
        if name == "p":
            lines.append(paragraph_text(block))
        elif name == "tbl":
            for row in children(block, "tr"):
                cells = [
                    " ".join(paragraph_text(p) for p in descendants(cell, "p")).strip()
                    for cell in children(row, "tc")
                ]
                lines.append(" | ".join(cells))
            lines.append("")
        elif name in ("sdt", "sdtContent", "customXml"):
            docx_blocks(block, lines)


def extract_docx(data, args):
    package = open_package(data, args.max_bytes)
    document = read_xml(package, "word/document.xml")
    body = next(iter(children(document, "body")), None)
    lines = []
    docx_blocks(body if body is not None else [], lines)
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    if not text:
        raise Unreadable("the document has no text")
    return {"text": text, "images": []}


# ── PPTX ──────────────────────────────────────────────────────────────


def extract_pptx(data, args):
    package = open_package(data, args.max_bytes)
    presentation = read_xml(package, "ppt/presentation.xml")
    rels = relationships(package, "ppt/_rels/presentation.xml.rels")
    out = []
    for number, slide_id in enumerate(descendants(presentation, "sldId"), 1):
        part = resolve_part("ppt", rels.get(relation_id(slide_id), ""))
        slide = read_xml(package, part, optional=True)
        if slide is None:
            continue
        lines = ["".join(t.text or "" for t in descendants(p, "t")) for p in descendants(slide, "p")]
        lines = [line for line in lines if line.strip()]
        out += [f"Slide {number}", *(lines or ["(no text)"]), ""]
    text = "\n".join(out).rstrip("\n")
    if not text:
        raise Unreadable("the presentation has no slides")
    return {"text": text, "images": []}


# ── PDF (poppler) ────────────────────────────────────────────────────


def poppler_tool(name, directory):
    if directory:
        for candidate in (name, f"{name}.exe"):
            path = os.path.join(directory, candidate)
            if os.path.isfile(path):
                return path
        return None
    return shutil.which(name)


def run_tool(command):
    try:
        result = subprocess.run(command, capture_output=True, timeout=TOOL_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        raise Unreadable(f"{os.path.basename(command[0])} timed out")
    if result.returncode != 0:
        message = result.stderr.decode("utf-8", "replace").strip().splitlines()
        raise Unreadable(message[-1] if message else f"{os.path.basename(command[0])} failed")
    return result.stdout


def page_list(pages):
    return ", ".join(str(p) for p in pages)


def extract_pdf(data, args):
    pdftotext = poppler_tool("pdftotext", args.poppler)
    if not pdftotext:
        raise Unreadable("reading PDF needs poppler (pdftotext) on the server")
    pdftoppm = poppler_tool("pdftoppm", args.poppler)
    with tempfile.TemporaryDirectory() as tmp:
        source = os.path.join(tmp, "input.pdf")
        with open(source, "wb") as fh:
            fh.write(data)
        raw = run_tool([pdftotext, "-layout", "-enc", "UTF-8", source, "-"]).decode("utf-8", "replace")
        pages = raw.split("\f")
        if pages and not pages[-1].strip():
            pages.pop()
        scanned = [n for n, page in enumerate(pages, 1) if len(page.strip()) < PDF_EMPTY_PAGE_CHARS]
        notes = []
        images = []
        if scanned and pdftoppm:
            for page in scanned[: args.max_pdf_images]:
                prefix = os.path.join(tmp, f"page-{page}")
                run_tool([pdftoppm, "-png", "-r", "110", "-f", str(page), "-l", str(page), "-singlefile", source, prefix])
                with open(f"{prefix}.png", "rb") as fh:
                    images.append({"mimeType": "image/png", "data": base64.b64encode(fh.read()).decode("ascii"), "page": page})
        left = scanned[len(images):]
        if left:
            why = f"only {args.max_pdf_images} pages are sent as images" if pdftoppm else "pdftoppm is not installed"
            notes.append(f"Pages {page_list(left)} have no text layer and are not included ({why}).")
        body = [f"--- Page {n} ---\n{page.rstrip()}" for n, page in enumerate(pages, 1) if n not in scanned]
        text = "\n\n".join(notes + body).strip()
        if not text and not images:
            raise Unreadable("the PDF has no extractable text")
        return {"text": text, "images": images}


EXTRACTORS = {"xlsx": extract_xlsx, "docx": extract_docx, "pptx": extract_pptx, "pdf": extract_pdf}


# ── 표 질의 (XLSX · CSV → 메모리 SQLite, 읽기 전용 SELECT 하나) ───────────

QUERY_MAX_ROWS = 200
QUERY_TIMEOUT_SECONDS = 10
NUMBER = re.compile(r"-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?")


def table_value(value):
    text = value.strip()
    if not text:
        return None
    if NUMBER.fullmatch(text):
        plain = text.replace(",", "")
        return float(plain) if "." in plain else int(plain)
    return text


def column_names(header, width):
    names, seen = [], {}
    for i in range(width):
        base = (header[i].strip() if i < len(header) else "") or f"col{i + 1}"
        seen[base] = seen.get(base, 0) + 1
        names.append(base if seen[base] == 1 else f"{base}_{seen[base]}")
    return names


def quote(identifier):
    return '"' + identifier.replace('"', '""') + '"'


def load_tables(db, tables):
    described = []
    for name, rows in tables:
        if not rows:
            continue
        width = max(len(r) for r in rows)
        columns = column_names(rows[0], width)
        db.execute(f"CREATE TABLE {quote(name)} ({', '.join(quote(c) for c in columns)})")
        body = [[table_value(r[i]) if i < len(r) else None for i in range(width)] for r in rows[1:]]
        db.executemany(f"INSERT INTO {quote(name)} VALUES ({', '.join('?' * width)})", body)
        described.append({"name": name, "columns": columns, "rows": len(body)})
    return described


def read_only(action, *_):
    allowed = (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION)
    return sqlite3.SQLITE_OK if action in allowed else sqlite3.SQLITE_DENY


def query_tables(kind, data, args):
    if kind == "xlsx":
        tables = xlsx_sheets(data, args)
    elif kind == "csv":
        text = data.decode("utf-8-sig", "replace")
        tables = [(args.table or "data", list(itertools.islice(csv.reader(io.StringIO(text)), MAX_ROWS)))]
    else:
        raise Unreadable(f"{kind} files cannot be queried; only XLSX and CSV can")
    db = sqlite3.connect(":memory:")
    described = load_tables(db, tables)
    db.set_authorizer(read_only)
    deadline = [None]

    def too_slow():
        deadline[0] = deadline[0] or time.monotonic() + QUERY_TIMEOUT_SECONDS
        return 1 if time.monotonic() > deadline[0] else 0

    db.set_progress_handler(too_slow, 10_000)
    try:
        cursor = db.execute(args.sql)
        rows = cursor.fetchmany(QUERY_MAX_ROWS + 1)
    except sqlite3.Error as exc:
        raise Unreadable(f"SQL error: {exc}")
    columns = [d[0] for d in cursor.description or []]
    return {
        "tables": described,
        "columns": columns,
        "rows": [list(r) for r in rows[:QUERY_MAX_ROWS]],
        "truncated": len(rows) > QUERY_MAX_ROWS,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("kind", choices=sorted([*EXTRACTORS, "csv"]))
    parser.add_argument("--poppler", default="", help="directory that holds pdftotext / pdftoppm")
    parser.add_argument("--max-bytes", type=int, default=50 * 1024 * 1024)
    parser.add_argument("--max-pdf-images", type=int, default=5)
    parser.add_argument("--sql", help="query mode: run one read-only SELECT over the file's tables")
    parser.add_argument("--table", default="", help="query mode: table name for a CSV file")
    args = parser.parse_args()
    data = sys.stdin.buffer.read()
    try:
        if len(data) > args.max_bytes:
            raise Unreadable(f"file is too large ({len(data)} bytes)")
        if args.sql is not None:
            result = query_tables(args.kind, data, args)
        elif args.kind in EXTRACTORS:
            result = EXTRACTORS[args.kind](data, args)
        else:
            raise Unreadable(f"{args.kind} needs --sql")
    except Unreadable as exc:
        sys.stderr.write(f"{exc}\n")
        return 2
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
