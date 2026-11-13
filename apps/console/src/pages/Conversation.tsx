import { useEffect, useMemo } from 'react';
import { BotIcon, InfoIcon, type LucideIcon, PaperclipIcon, UserIcon } from 'lucide-react';
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
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
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

const ROLE: Record<
  MessageView['role'],
  { label: string; icon: LucideIcon; avatarClass: string; labelClass?: string }
> = {
  user: {
    label: '사용자',
    icon: UserIcon,
    avatarClass: 'bg-primary/10 text-primary',
    labelClass: 'text-primary',
  },
  assistant: { label: 'Agent', icon: BotIcon, avatarClass: 'bg-muted text-foreground' },
  system: { label: '시스템', icon: InfoIcon, avatarClass: 'bg-muted text-muted-foreground' },
};

/** Agent 답변 — shared/markdown 이 만드는 태그에 직접 스타일을 입힌다 */
const MARKDOWN_CLASS = cn(
  'text-sm leading-relaxed break-words [&>:first-child]:mt-0 [&>:last-child]:mb-0',
  '[&_blockquote]:mb-2 [&_ol]:mb-2 [&_p]:mb-2 [&_pre]:mb-2 [&_ul]:mb-2',
  '[&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5',
  '[&_:is(h3,h4,h5,h6)]:mt-3 [&_:is(h3,h4,h5,h6)]:mb-1.5 [&_:is(h3,h4,h5,h6)]:font-semibold [&_h3]:text-base',
  '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
  '[&_blockquote]:border-l-[3px] [&_blockquote]:pl-2.5 [&_blockquote]:text-muted-foreground',
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[12.5px]',
  '[&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-2.5 [&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_.md-table]:mb-2 [&_.md-table]:overflow-x-auto [&_table]:border-collapse [&_table]:text-[13px]',
  '[&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1 [&_th]:text-left',
  '[&_hr]:my-2.5',
);

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
      <div className="grid grid-cols-1 items-start gap-x-4 gap-y-0 min-[1100px]:grid-cols-[minmax(0,1fr)_340px]">
        <Card title="대화 기록" description="위젯 사용자와 Agent 가 주고받은 메시지입니다." flush>
          {data.messages.length === 0 ? (
            <Empty title="메시지가 없어요" />
          ) : (
            <ol className="divide-y">
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
        <div className="min-w-0">
          <Card title="이 대화의 작업" flush>
            {data.tasks.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">작업이 없어요.</p>
            ) : (
              <ul className="divide-y">
                {[...data.tasks].reverse().map((t) => (
                  <li key={t.id} className="flex flex-col gap-1.5 px-4 py-3">
                    <Link
                      to={`/tasks/${t.id}`}
                      className="truncate font-medium text-foreground hover:text-primary"
                      title={t.title}
                    >
                      {t.title}
                    </Link>
                    <span className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={t.status} />
                      <span className="text-xs text-muted-foreground">
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
              <p className="text-sm whitespace-pre-wrap text-muted-foreground">{data.summary}</p>
            ) : (
              <p className="text-sm text-muted-foreground">아직 요약할 만큼 대화가 길지 않아요.</p>
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
  const role = ROLE[message.role];
  const RoleIcon = role.icon;
  return (
    <li className={cn('flex gap-3 px-4 py-3', message.role === 'user' && 'bg-muted/40')}>
      <Avatar size="sm" className="mt-0.5">
        <AvatarFallback className={role.avatarClass}>
          <RoleIcon className="size-3.5" aria-hidden="true" />
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <span className={cn('text-sm font-bold', role.labelClass)}>{role.label}</span>
          <span className="text-xs text-muted-foreground">
            <Time iso={message.createdAt} absolute />
          </span>
          {task && (
            <Link
              to={`/tasks/${task.id}`}
              className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              {message.role === 'user' ? '시작한 작업' : '작업'} ·{' '}
              <StatusBadge status={task.status} />
            </Link>
          )}
        </div>
        {text &&
          (message.role === 'assistant' ? (
            <Markdown text={text} className={MARKDOWN_CLASS} />
          ) : (
            <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{text}</p>
          ))}
        {attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {attachments.map((a) => (
              <AttachmentChip
                key={a.artifactId}
                artifactId={a.artifactId}
                file={files?.[a.artifactId]}
              />
            ))}
          </div>
        )}
      </div>
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
      {!download.pending && <PaperclipIcon aria-hidden="true" />}
      {file ? file.fileName : '첨부 파일'}
      <Badge>{file ? formatBytes(file.sizeBytes) : artifactId.slice(0, 8)}</Badge>
    </Button>
  );
}
