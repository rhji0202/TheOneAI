# 화면 설계 v1.0

- 캔버스(와이어프레임 + 화면 설명): https://claude.ai/artifact/GqBRXWjTsb7WE8G9RLB2BD
  - 기본은 비공개다. 팀에 공유하려면 캔버스 페이지의 Share 메뉴에서 공유한다.
- 기준: 기획안 v2.0 · 범위 P0 · P1 (P2 Marketplace · Billing 제외)
- 연관 문서: [API 명세](api-spec.md) · [데이터 모델](data-model.md)

각 화면의 마젠타 번호는 오른쪽 설명 패널 항목과 대응하며, 설명에 관련 모듈 · API · 테이블을 적었다.

## 화면 목록

| ID | 화면 | 영역 | 우선순위 | 핵심 내용 |
|---|---|---|---|---|
| W-01 | 위젯 홈 · 런처 | Widget | P0 | 진행 중 작업 복원, Skill 기반 추천 작업, 첨부 업로드 |
| W-02 | 대화 · 실행 스트리밍 | Widget | P0 | 실행 계획 카드, 단계별 Tool/Skill, 재계획 배지, 스트리밍, 추가 지시 · 중지 |
| W-03 | 승인 요청 | Widget | P1 | 위험도, 실행 인자 미리보기, 범위 승인, 만료 → 일시정지, 수정 요청 |
| W-04 | 결과 · 산출물 | Widget | P0 | 산출물 다운로드, 피드백, 후속 제안 |
| W-05 | 작업 목록 · 복구 | Widget | P0 · P1 | SSE 재연결, 자동 복구 상태, 체크포인트 재개 |
| C-01 | 대시보드 | Console | P1 | 기획안 11장 품질 지표, 실행 중 작업, 승인 대기, 실패 · 복구 |
| C-02 | 작업 상세 · 실행 트레이스 | Console | P0 | Agent Loop 타임라인, checkpoint, 재계획, Sandbox 상세, Registry 버전 고정 |
| C-03 | Agent 설정 | Console | P0 | 역할별 모델, 지침, Tool/Skill 허용 목록, 실행 정책, Memory, 초안 → 배포 |
| C-04 | MCP 서버 목록 · 상세 | Console | P0 | Tool 스키마 검증, 권한 등급, 변경 감지 → Registry 새 버전 |
| C-05 | MCP 서버 연결 | Console | P0 | 4단계 마법사, 이미지 서명, SSRF 검사, Tool 보안 검사 |
| C-06 | Skill 관리 | Console | P0 | SKILL.md 미리보기, 공급망 검증, 버전 · 테스트 |
| C-07 | 승인 · 권한 정책 | Console | P1 | 승인 큐 · 대리 승인, 등급별 기본 정책, 조건 규칙 |
| C-08 | Memory 탐색 | Console | P1 | 의미 · 키워드 검색, 출처 추적, 격리, 사용자 데이터 삭제 |
| C-09 | Widget 설치 · 테마 | Console | P0 | 설치 코드, 서명 토큰 사용자 연동, 허용 도메인, 테마 미리보기 |

2차 설계 대상: 감사 로그 화면, 멤버 · 역할 관리, 대화 기록 목록.

## 공통 규칙

**작업 상태 배지** — Widget 과 Console 이 같은 색과 문구를 쓴다.

| 값 | 문구 | 배경 / 글자 |
|---|---|---|
| `queued` | 대기 | `#F3F4F6` / `#4B5563` |
| `running` | 실행 중 | `#DBEAFE` / `#1D4ED8` |
| `waiting_approval` | 승인 대기 | `#FEF3C7` / `#92400E` |
| `paused` | 일시정지 | `#E5E7EB` / `#374151` |
| `recovering` | 복구 중 | `#EDE9FE` / `#6D28D9` |
| `completed` | 완료 | `#DCFCE7` / `#166534` |
| `failed` | 실패 | `#FEE2E2` / `#B91C1C` |
| `cancelled` | 취소 | `#F3F4F6` / `#4B5563` |

**타이포 · 색** — 본문 IBM Plex Sans KR, 코드 · ID · Tool 이름 IBM Plex Mono. 주요 색 Indigo `#4F46E5`(테넌트 브랜드 색으로 교체 가능, 흰 글자 대비 4.5:1 미만이면 자동 보정).

**위젯 크기** — 데스크톱 384 × 720 패널 + 56px 런처, 모바일은 전체 화면 시트. Shadow DOM 으로 호스트 스타일과 격리.

**접근성** — 스트리밍 응답 `aria-live="polite"`, 승인 카드 `role="alertdialog"` 로 포커스 이동, 모든 조작 키보드 가능, 텍스트 대비 4.5:1 이상, 터치 영역 44px 이상.

**보안 표시** — Tool 인자 · 결과의 Secret · 토큰 · 개인정보는 서버에서 마스킹 후 전송. 콘솔의 위젯 사용자는 가명(`user_8f2a`)으로만 표시.
