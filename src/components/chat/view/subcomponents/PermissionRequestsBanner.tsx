import React, { useState } from 'react';
import { FileEdit, FilePlus, FileSearch, Globe, Search, ShieldAlertIcon, TerminalSquare, TriangleAlert } from 'lucide-react';

import type { PendingPermissionRequest } from '../../types/types';
import { buildClaudeToolPermissionEntry, formatToolInputForDisplay } from '../../utils/chatPermissions';
import { describePermissionRequest, type PermissionKind } from '../../utils/describePermission';
import { getClaudeSettings } from '../../utils/chatStorage';
import { getPermissionPanel, registerPermissionPanel } from '../../tools/configs/permissionPanelRegistry';
import { AskUserQuestionPanel } from '../../tools/components/InteractiveRenderers';
import {
  Confirmation,
  ConfirmationActions,
  ConfirmationAction,
} from '../../../../shared/view/ui';

registerPermissionPanel('AskUserQuestion', AskUserQuestionPanel);

interface PermissionRequestsBannerProps {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  handleGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
}

const KIND_ICON: Record<PermissionKind, React.ComponentType<{ className?: string }>> = {
  edit: FileEdit,
  write: FilePlus,
  command: TerminalSquare,
  read: FileSearch,
  web: Globe,
  search: Search,
  other: ShieldAlertIcon,
};

// Сколько строк правки показывать сразу — остальное прокруткой.
const PREVIEW_MAX = 'max-h-48';

function DiffPreview({ removed, added }: { removed?: string; added?: string }) {
  if (!removed && !added) return null;
  const lines = (text: string, sign: string, cls: string) => text.split('\n').map((line, index) => (
    <div key={`${sign}${index}`} className={`whitespace-pre-wrap break-all px-2 ${cls}`}>
      <span className="mr-2 select-none opacity-60">{sign}</span>{line || ' '}
    </div>
  ));
  return (
    <div className={`mt-2 overflow-auto rounded-md border border-border/60 bg-muted/30 py-1 font-mono text-xs leading-5 ${PREVIEW_MAX}`}>
      {removed && lines(removed, '−', 'bg-red-500/10 text-red-700 dark:text-red-300')}
      {added && lines(added, '+', 'bg-green-500/10 text-green-700 dark:text-green-300')}
    </div>
  );
}

function PermissionCard({
  request,
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
}: {
  request: PendingPermissionRequest;
} & PermissionRequestsBannerProps) {
  const [explaining, setExplaining] = useState(false);
  const [reason, setReason] = useState('');
  const rawInput = formatToolInputForDisplay(request.input);
  const info = describePermissionRequest(request.toolName, request.input ?? rawInput);
  const Icon = KIND_ICON[info.kind];
  const permissionEntry = buildClaudeToolPermissionEntry(request.toolName, rawInput);
  const settings = getClaudeSettings();
  const alreadyAllowed = permissionEntry ? settings.allowedTools.includes(permissionEntry) : false;
  const matchingRequestIds = permissionEntry
    ? pendingPermissionRequests
        .filter((item) => buildClaudeToolPermissionEntry(item.toolName, formatToolInputForDisplay(item.input)) === permissionEntry)
        .map((item) => item.requestId)
    : [request.requestId];

  const deny = (message?: string) => handlePermissionDecision(request.requestId, {
    allow: false,
    message: message?.trim() ? `Пользователь запретил это действие и пояснил: ${message.trim()}` : 'Пользователь запретил это действие.',
  });

  return (
    <Confirmation approval="pending" className={info.danger ? 'border-red-400/60' : undefined}>
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${info.danger ? 'bg-red-500/10 text-red-600 dark:text-red-400' : 'bg-primary/10 text-primary'}`}>
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">{info.title}</div>
          {info.fileName && (
            <div className="mt-0.5 min-w-0">
              <span className="font-medium text-foreground">{info.fileName}</span>
              {info.fileDir && <span className="ml-2 break-all text-xs text-muted-foreground">{info.fileDir}</span>}
            </div>
          )}
          {info.note && <div className="mt-0.5 text-xs text-muted-foreground">{info.note}</div>}
          {info.code && (
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border/60 bg-muted/40 px-2 py-1.5 font-mono text-xs text-foreground">
              {info.code}
            </pre>
          )}
          <DiffPreview removed={info.removed} added={info.added} />
          {info.danger && (
            <div className="mt-2 flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
              {info.danger}
            </div>
          )}
          {rawInput && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Все подробности</summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/50 p-2 text-xs text-muted-foreground">
                {rawInput}
              </pre>
            </details>
          )}
          {explaining && (
            <div className="mt-3 flex gap-2">
              <input
                autoFocus
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') deny(reason);
                  if (event.key === 'Escape') setExplaining(false);
                }}
                placeholder="Что сделать иначе? Claude прочитает это"
                className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary"
              />
              <ConfirmationAction variant="outline" onClick={() => deny(reason)}>Отправить</ConfirmationAction>
            </div>
          )}
        </div>
      </div>

      <ConfirmationActions className="mt-3 flex flex-wrap justify-end gap-2">
        <ConfirmationAction
          variant="outline"
          onClick={() => (explaining ? deny(reason) : setExplaining(true))}
          title="Claude не сделает этого; можно объяснить, что сделать вместо"
        >
          Запретить
        </ConfirmationAction>
        {permissionEntry && (
          <ConfirmationAction
            variant="outline"
            title={`Больше не спрашивать про такие действия в этой программе (правило ${permissionEntry}). Убрать — в настройках.`}
            onClick={() => {
              if (!alreadyAllowed) handleGrantToolPermission({ entry: permissionEntry, toolName: request.toolName });
              handlePermissionDecision(matchingRequestIds, { allow: true, rememberEntry: permissionEntry });
            }}
          >
            {alreadyAllowed ? 'Разрешено всегда' : info.alwaysLabel}
          </ConfirmationAction>
        )}
        <ConfirmationAction variant="default" onClick={() => handlePermissionDecision(request.requestId, { allow: true })}>
          Разрешить
        </ConfirmationAction>
      </ConfirmationActions>
    </Confirmation>
  );
}

export default function PermissionRequestsBanner(props: PermissionRequestsBannerProps) {
  const { pendingPermissionRequests, handlePermissionDecision } = props;
  // Plan-запросы показывает сам план (PlanDisplay).
  const filteredRequests = pendingPermissionRequests.filter(
    (r) => r.toolName !== 'ExitPlanMode' && r.toolName !== 'exit_plan_mode',
  );
  if (!filteredRequests.length) return null;

  return (
    <div className="mb-3 space-y-2">
      {filteredRequests.map((request) => {
        const CustomPanel = getPermissionPanel(request.toolName);
        if (CustomPanel) {
          return <CustomPanel key={request.requestId} request={request} onDecision={handlePermissionDecision} />;
        }
        return <PermissionCard key={request.requestId} request={request} {...props} />;
      })}
    </div>
  );
}
