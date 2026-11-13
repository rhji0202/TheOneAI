import { useEffect, useMemo } from 'react';
import { Link, useParams } from 'react-router';
import { formatBytes } from '../../../shared/format';
import { Markdown } from '../../../shared/markdown';
import { ApiError } from '../api';
import { useApi } from '../auth';
import {
  Badge,
  Card,
  Empty,
  ErrorNotice,
  Loading,
  PageHeader,
  ShortId,
  StatusBadge,
  Time,
  useAction,
  useQuery,
  useToast,
} from '../ui';
import { Button } from '@/components/ui/button';
import { isLive, type TaskStatus } from './Tasks';

/* ───────────── 타입 (TasksAdminService.conversation) ───────────── */

type ContentBlock = { type: 'text'; text: string } | { type: 'attachment'; artifactId: string };

interface MessageView {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: ContentBlock[];
  taskId: string | null;
  createdAt: string;
}

interface ConversationView {
  id: string;
  title: string | null;
  agentName: string;
  endUserPseudonym: string;
  summary: string | null;
  createdAt: string;
  messages: MessageView[];
  /** artifactId → 파일 정보 */
  attachments?: Record<string, AttachmentInfo>;
  tasks: { id: string; title: string; status: TaskStatus; createdAt: string }[];
}

interface AttachmentInfo {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

const ROLE_LABEL: Record<MessageView['role'], string> = {
  user: '사용자',
  assistant: 'Agent',
  system: '시스템',
};

/* ───────────── 대화 보기 (C-02) ───────────── */

export function ConversationPage() {
  const { id = '' } = useParams();
  const api = useApi();
  const conv = useQuery(() => api.get<ConversationView>(`/v1/admin/conversations/${id}`), [id]);
  const data = conv.data;
  const anyActive = data?.tasks.some((t) => isLive(t.status)) ?? false;
  const { reload } = conv;
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, 5_000);
    return () => clearInterval(timer);
  }, [anyActive, reload]);

  const taskById = useMemo(() => new Map((data?.tasks ?? []).map((t) => [t.id, t])), [data?.tasks]);

  if (!data) {
    return (
      <>
        <PageHeader title="대화" back={{ to: '/tasks', label: '작업' }} />
        {conv.error ? (
          <ErrorNotice
            error={
              conv.error instanceof ApiError && conv.error.status === 404
                ? new Error('대화를 찾을 수 없어요.')
                : conv.error
            }
            onRetry={() => void conv.reload()}
          />
        ) : (
          <Loading />
        )}
      </>
    );
  }

  const title =
    data.title ??
    data.messages
      .find((m) => m.role === 'user')
      ?.content.find((b): b is { type: 'text'; text: string } => b.type === 'text')
      ?.text.slice(0, 60) ??
    '제목 없는 대화';

  return (
    <>
      <PageHeader
        back={{ to: '/tasks', label: '작업' }}
        title={title}
        meta={
          <>
            <ShortId id={data.id} />
            <span>{data.agentName}</span>
            <span>· {data.endUserPseudonym}</span>
            <span>
              · <Time iso={data.createdAt} absolute />
            </span>
            <span>· 메시지 {data.messages.length}개</span>
          </>
        }
      />
      <div className="grid grid-main-side">
        <Card title="대화 기록" description="위젯 사용자와 Agent 가 주고받은 메시지입니다." flush>
          {data.messages.length === 0 ? (
            <Empty title="메시지가 없어요" />
          ) : (
            <ol className="tk-thread">
              {data.messages.map((m) => (
                <MessageItem
                  key={m.id}
                  message={m}
                  task={m.taskId ? taskById.get(m.taskId) : undefined}
                  files={data.attachments}
                />
              ))}
            </ol>
          )}
        </Card>
        <div className="stack">
          <Card title="이 대화의 작업" flush>
            {data.tasks.length === 0 ? (
              <p className="muted tk-pad">작업이 없어요.</p>
            ) : (
              <ul className="tk-list">
                {[...data.tasks].reverse().map((t) => (
                  <li key={t.id} className="tk-conv-task">
                    <Link to={`/tasks/${t.id}`} className="tk-conv-task-title" title={t.title}>
                      {t.title}
                    </Link>
                    <span className="row">
                      <StatusBadge status={t.status} />
                      <span className="cell-sub">
                        <Time iso={t.createdAt} />
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card
            title="대화 요약"
            description="오래된 메시지는 요약해 다음 작업의 Context 로 씁니다."
          >
            {data.summary ? (
              <p className="tk-conv-summary">{data.summary}</p>
            ) : (
              <p className="muted">아직 요약할 만큼 대화가 길지 않아요.</p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function MessageItem({
  message,
  task,
  files,
}: {
  message: MessageView;
  task: ConversationView['tasks'][number] | undefined;
  files?: Record<string, AttachmentInfo>;
}) {
  const text = message.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n');
  const attachments = message.content.filter(
    (b): b is { type: 'attachment'; artifactId: string } => b.type === 'attachment',
  );
  return (
    <li className={`tk-msg tk-msg-${message.role}`}>
      <div className="tk-msg-head">
        <span className="tk-msg-role">{ROLE_LABEL[message.role]}</span>
        <span className="cell-sub">
          <Time iso={message.createdAt} absolute />
        </span>
        {task && (
          <Link to={`/tasks/${task.id}`} className="tk-msg-task">
            {message.role === 'user' ? '시작한 작업' : '작업'} ·{' '}
            <StatusBadge status={task.status} />
          </Link>
        )}
      </div>
      {text &&
        (message.role === 'assistant' ? (
          <Markdown text={text} className="tk-md tk-msg-text" />
        ) : (
          <p className="tk-msg-text tk-plain">{text}</p>
        ))}
      {attachments.length > 0 && (
        <div className="tk-msg-attachments">
          {attachments.map((a) => (
            <AttachmentChip
              key={a.artifactId}
              artifactId={a.artifactId}
              file={files?.[a.artifactId]}
            />
          ))}
        </div>
      )}
    </li>
  );
}

function AttachmentChip({ artifactId, file }: { artifactId: string; file?: AttachmentInfo }) {
  const api = useApi();
  const toast = useToast();
  const download = useAction(() =>
    api.download(
      `/v1/admin/artifacts/${artifactId}/download`,
      file?.fileName ?? `attachment-${artifactId.slice(0, 8)}`,
    ),
  );
  useEffect(() => {
    if (download.error) toast(download.error.message, 'danger');
  }, [download.error, toast]);
  return (
    <Button
      variant="outline"
      size="sm"
      loading={download.pending}
      onClick={() => void download.run()}
    >
      📎 {file ? file.fileName : '첨부 파일'}{' '}
      <Badge>{file ? formatBytes(file.sizeBytes) : artifactId.slice(0, 8)}</Badge>
    </Button>
  );
}
