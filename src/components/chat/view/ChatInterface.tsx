import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon } from 'lucide-react';

import type { SessionActivity } from '../../../hooks/useSessionProtection';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import PermissionContext from '../../../contexts/PermissionContext';
import type { ChatInterfaceProps, ChatMessage, PermissionMode, Provider  } from '../types/types';
import { useChatProviderState } from '../hooks/useChatProviderState';
import { useChatSessionState } from '../hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '../hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '../hooks/useChatComposerState';
import { useSessionStore } from '../../../stores/useSessionStore';
import { authenticatedFetch } from '../../../utils/api';

import ChatMessagesPane from './subcomponents/ChatMessagesPane';
import ChatRequestBar from './subcomponents/ChatRequestBar';
import ChatComposer from './subcomponents/ChatComposer';
import CommandResultModal from './subcomponents/CommandResultModal';
import { knownRunStartedAt } from '../utils/liveRunCursor';

/**
 * Сколько ждать после восстановления связи, прежде чем признать ответ
 * потерянным. Подписка уходит сразу, но подтверждение от сервера приходит не
 * мгновенно — без этой паузы живой ответ объявлялся бы неудачей.
 */
const RECONNECT_GRACE_MS = 8000;

function ChatInterface({
  isActive,
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  onFileOpen,
  onInputFocusChange,
  onSessionProcessing,
  onSessionIdle,
  processingSessions,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  showRawParameters,
  showThinking,
  sendByCtrlEnter,
  externalMessageUpdate,
  newSessionTrigger,
  onStartNewChat,
  onShowAllTasks,
}: ChatInterfaceProps) {
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const { subscribe, isConnected } = useWebSocket();
  const { t } = useTranslation('chat');

  const sessionStore = useSessionStore();
  // Keyed by session id, NOT one buffer for the whole component. A client can
  // receive live deltas for more than one session at a time — watching a run
  // started elsewhere (another device, the CLI) while typing in your own is
  // the ordinary case, not an edge case. With a single shared buffer those
  // two streams concatenate into each other and both sessions render text
  // that belongs to the other one.
  const streamTimerRef = useRef(new Map<string, number>());
  const accumulatedStreamRef = useRef(new Map<string, string>());
  // Mirrors streamTimerRef/accumulatedStreamRef for the live thinking block —
  // a separate accumulator because thinking and reply text are independent
  // live rows within one turn (see useChatRealtimeHandlers' flushThinking).
  const thinkingStreamTimerRef = useRef(new Map<string, number>());
  const accumulatedThinkingRef = useRef(new Map<string, string>());
  const thinkingStartedAtRef = useRef(new Map<string, number>());
  // When each session's `chat.subscribe` was last sent; idle acks older than
  // a later local request are discarded as stale.
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  // Highest live `seq` observed per session. Written by the realtime handler
  // on every sequenced frame, read whenever a `chat.subscribe` is sent so the
  // server replays only the events this client actually missed.
  const lastSeqRef = useRef(new Map<string, number>());

  const resetStreamingState = useCallback(() => {
    for (const timer of streamTimerRef.current.values()) clearTimeout(timer);
    for (const timer of thinkingStreamTimerRef.current.values()) clearTimeout(timer);
    streamTimerRef.current.clear();
    thinkingStreamTimerRef.current.clear();
    accumulatedStreamRef.current.clear();
    accumulatedThinkingRef.current.clear();
    thinkingStartedAtRef.current.clear();
  }, []);

  const {
    provider,
    setProvider,
    cursorModel,
    setCursorModel,
    claudeModel,
    setClaudeModel,
    codexModel,
    setCodexModel,
    currentProviderEffort,
    currentProviderEffortOptions,
    currentProviderModel,
    currentProviderModelOptions,
    opencodeModel,
    setOpenCodeModel,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    availablePermissionModes,
    selectPermissionMode,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelsLoading,
    providerModelActions,
    selectProviderModel,
    selectProviderEffort,
    resolvePermissionModeForProvider,
  } = useChatProviderState({
    selectedSession,
    selectedProject,
  });

  const {
    chatMessages,
    addMessage,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleUserScrollGesture,
    requestLatestMessages,
    loadOlderMessagesNow,
    historyLoadError,
    retryHistoryLoad,
    transcriptMissing,
    setTopSentinel,
  } = useChatSessionState({
    isActive,
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    externalMessageUpdate,
    newSessionTrigger,
    processingSessions,
    onSessionIdle,
    resetStreamingState,
    statusCheckSentAtRef,
    lastSeqRef,
    sessionStore,
  });

  // Brand-new conversation: the composer allocated a stable session id via
  // the session gateway before the first send. Record it locally and put it
  // in the URL — this id never changes again, so there is no later handoff.
  const handleSessionEstablished = useCallback<NonNullable<ChatInterfaceProps['onSessionEstablished']>>((sessionId, context) => {
    setCurrentSessionId(sessionId);
    onSessionEstablished?.(sessionId, context);
    onNavigateToSession?.(sessionId);
  }, [setCurrentSessionId, onSessionEstablished, onNavigateToSession]);

  const {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedFiles,
    setAttachedFiles,
    uploadingFiles,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker,
    handleSubmit,
    queuedDrafts,
    editQueuedDraft,
    deleteQueuedDraft,
    sendNowQueuedDraft,
    moveQueuedDraft,
    clearQueuedDrafts,
    handleVoiceTranscript,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
    handoffStatus,
    startHandoff,
    canHandoff,
  } = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    permissionMode,
    cyclePermissionMode,
    currentProviderModel,
    currentProviderEffort,
    isLoading: isProcessing,
    processingSessions,
    canAbortSession,
    tokenBudget,
    sendMessage,
    sendByCtrlEnter,
    newSessionTrigger,
    onStartNewChat,
    onSessionProcessing,
    onSessionEstablished: handleSessionEstablished,
    onInputFocusChange,
    onFileOpen,
    onShowSettings,
    scrollToBottom,
    addMessage,
    setIsUserScrolledUp,
    setPendingPermissionRequests,
    resolvePermissionModeForProvider,
  });

  // Обрыв связи во время ответа больше не остаётся без объяснения.
  //
  // Егор: «отправляю сообщение — и ни ответа, ни размышлений, ни ошибки,
  // вообще ничего». Так и было: сервер падал (09.09 — дважды за утро, от
  // нехватки памяти и от оборванной трубы), браузер молча ждал три секунды,
  // переподключался, получал от сервера «ничего не выполняется» — и снимал
  // признак работы. Человек оставался со своим сообщением и пустотой.
  //
  // Само падение лечится на сервере. Здесь — вторая половина обещания: если
  // связь всё же пропала посреди ответа, об этом говорится прямо, и видно,
  // что сообщение нужно отправить заново.
  //
  // Уточнение: сам по себе обрыв — ещё не провал. Браузер переподключается за
  // считанные секунды, и подписка на сессию заново цепляется к ЖИВОМУ ответу,
  // который всё это время считался на сервере. Объявлять неудачу сразу значит
  // врать в половине случаев и заставлять переспрашивать зря.
  //
  // Поэтому обрыв сначала показывается как состояние — «Связь потеряна,
  // восстанавливаем» в той же строке, где обычно видно, чем занят Клод. И
  // только если после восстановления связи ответ так и не продолжился,
  // появляется сообщение, что его нужно отправить заново.
  const lostWhileWaitingRef = useRef(false);
  const isProcessingRef = useRef(isProcessing);
  isProcessingRef.current = isProcessing;

  // Ответ мог не только продолжиться — он мог и ЗАКОНЧИТЬСЯ, пока связи не
  // было. Снимок Егора 11.09.26: сообщение обрывается на полуслове («**Что»),
  // а под ним красное «ответ не получен, отправьте ещё раз» — хотя ответ был
  // получен полностью и лежал на диске, просто хвост не долетел по проводу.
  // Отправив по этой подсказке ещё раз, он получал следующую ошибку — «в этой
  // сессии уже идёт работа». Один неверный вывод порождал вторую ошибку.
  //
  // Поэтому перед приговором смотрим на саму ленту: если после последнего
  // моего сообщения стоит ответ, ничего не потеряно — обновление ленты уже
  // подставило его целиком вместо оборванного куска.
  const chatMessagesRef = useRef(chatMessages);
  chatMessagesRef.current = chatMessages;

  const replyArrivedAfterLastUserMessage = useCallback(() => {
    const rows = chatMessagesRef.current;
    for (let index = rows.length - 1; index >= 0; index--) {
      const type = rows[index]?.type;
      if (type === 'user') return false;
      if (type === 'assistant' && (rows[index].content || '').trim().length > 0) return true;
    }
    return false;
  }, []);

  const wasConnectedRef = useRef(isConnected);
  useEffect(() => {
    const wasConnected = wasConnectedRef.current;
    wasConnectedRef.current = isConnected;

    if (wasConnected && !isConnected && isProcessing) {
      lostWhileWaitingRef.current = true;
      return;
    }

    if (wasConnected || !isConnected || !lostWhileWaitingRef.current) {
      return;
    }

    // Связь вернулась. Даём серверу время подтвердить, что ответ ещё живёт:
    // подписка уходит сразу, а подтверждение приходит не мгновенно.
    const timer = setTimeout(() => {
      if (!lostWhileWaitingRef.current) return;
      lostWhileWaitingRef.current = false;
      if (isProcessingRef.current) return;
      if (replyArrivedAfterLastUserMessage()) return;
      addMessage({
        type: 'error',
        content: t(
          'errors.connectionLostWhileWaiting',
          'Связь с сервером прервалась, ответ не получен. Отправьте сообщение ещё раз.',
        ),
        timestamp: new Date(),
      });
    }, RECONNECT_GRACE_MS);
    return () => clearTimeout(timer);
  }, [isConnected, isProcessing, addMessage, replyArrivedAfterLastUserMessage, t]);

  // Ответ продолжился сам — извиняться не за что, снимаем ожидание молча.
  useEffect(() => {
    if (isProcessing && isConnected) {
      lostWhileWaitingRef.current = false;
    }
  }, [isProcessing, isConnected]);

  // Пока связи нет, а ответ ждали, строка состояния показывает не пустоту и не
  // приговор, а честное «восстанавливаем». Прерывать в этот момент нечего,
  // поэтому кнопка остановки скрыта.
  const activityWithConnection = useMemo<SessionActivity | null>(() => {
    if (isConnected) return sessionActivity;
    if (!sessionActivity && !isProcessing) return sessionActivity;
    return {
      statusText: null,
      phase: 'reconnecting',
      detail: null,
      canInterrupt: false,
      startedAt: sessionActivity?.startedAt ?? Date.now(),
    };
  }, [isConnected, isProcessing, sessionActivity]);

  // On WebSocket reconnect, request a bounded persisted-tail sync (deferred
  // while Chat is hidden), then re-subscribe — the
  // `chat_subscribed` ack restores or clears the activity indicator, replays
  // missed live events, and re-attaches a still-running stream to this socket.
  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;
    await requestLatestMessages(selectedSession.id, isActive, 'reconnect');
    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{
        sessionId: selectedSession.id,
        lastSeq: lastSeqRef.current.get(selectedSession.id) ?? 0,
        runStartedAt: knownRunStartedAt(selectedSession.id) ?? null,
      }],
    });
  }, [isActive, requestLatestMessages, selectedProject, selectedSession, sendMessage]);

  useChatRealtimeHandlers({
    isActive,
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    thinkingStreamTimerRef,
    accumulatedThinkingRef,
    thinkingStartedAtRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect: handleWebSocketReconnect,
    requestLatestMessages,
    sessionStore,
  });

  useEffect(() => {
    if (!canAbortSession) {
      return;
    }

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      handleAbortSession();
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortSession]);

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests,
    handlePermissionDecision,
  }), [pendingPermissionRequests, handlePermissionDecision]);

  // A composer pick becomes the default for new chats and, when a session is
  // open, is recorded against that session so reopening it restores this model.
  // «Вернуться сюда» под своим сообщением: сервер останавливает ход, убирает
  // из разговора это сообщение и всё после него (полная копия остаётся рядом
  // с файлом разговора), а текст возвращается в поле ввода — поправить и
  // отправить заново. Как «rewind» в Claude Code.
  const rewindSessionId = currentSessionId || selectedSession?.id || null;
  const handleRewindToMessage = useCallback(async (message: ChatMessage) => {
    const sessionId = rewindSessionId;
    if (!sessionId) return;
    const confirmed = window.confirm(
      'Вернуться к этому сообщению?\n\n'
      + 'Оно и всё, что было после него, уберётся из чата; если агент сейчас работает — он остановится. '
      + 'Текст сообщения вернётся в поле ввода: поправьте и отправьте заново.\n\n'
      + 'Изменения в файлах, которые агент уже успел сделать, не откатываются.',
    );
    if (!confirmed) return;

    try {
      const response = await authenticatedFetch(
        `/api/providers/sessions/${encodeURIComponent(sessionId)}/rewind`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messageId: typeof message.sourceId === 'string' ? message.sourceId : null,
            text: typeof message.content === 'string' ? message.content : null,
          }),
        },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        window.alert(payload?.error?.message || 'Не получилось вернуться к сообщению. Попробуйте ещё раз.');
        return;
      }

      const data = payload.data as { text?: string; queuedTexts?: string[] };
      // Лента — заново с сервера: живые строки отменённого хода и его поток
      // иначе остались бы на экране.
      sessionStore.clearRealtime(sessionId);
      resetStreamingState();
      retryHistoryLoad();

      const draft = [data.text ?? '', ...(data.queuedTexts ?? [])]
        .map((part) => part.trim())
        .filter(Boolean)
        .join('\n\n');
      setInput(draft);
      requestAnimationFrame(() => textareaRef.current?.focus());
    } catch (error) {
      console.error('Rewind to message failed:', error);
      window.alert('Не получилось вернуться к сообщению: нет связи с сервером. Попробуйте ещё раз.');
    }
  }, [rewindSessionId, sessionStore, resetStreamingState, retryHistoryLoad, setInput, textareaRef]);

  const handleSelectComposerModel = useCallback(async (model: string) => {
    try {
      await selectProviderModel(provider, model, currentSessionId || selectedSession?.id || null);
    } catch (error) {
      console.error('Error changing the active session model:', error);
    }
  }, [currentSessionId, provider, selectProviderModel, selectedSession?.id]);

  const handleSelectComposerEffort = useCallback(async (effort: string) => {
    try {
      await selectProviderEffort(provider, effort, currentSessionId || selectedSession?.id || null);
    } catch (error) {
      console.error('Error changing the active session reasoning effort:', error);
    }
  }, [currentSessionId, provider, selectProviderEffort, selectedSession?.id]);

  // Mirrors ChatComposer's own visibility check so the message pane can
  // reserve enough bottom space to keep the floating status tab from
  // overlapping the last message.
  const hasActivityIndicator = Boolean(sessionActivity && pendingPermissionRequests.length === 0);

  const selectedProviderLabel =
    provider === 'cursor'
      ? t('messageTypes.cursor')
      : provider === 'codex'
        ? t('messageTypes.codex')
        : provider === 'opencode'
            ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
          : t('messageTypes.claude');

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <PermissionContext.Provider value={permissionContextValue}>
      <div className="flex h-full min-h-0 flex-col">
        <ChatRequestBar
          scrollContainerRef={scrollContainerRef}
          messagesRevision={chatMessages.length}
        />
        <ChatMessagesPane
          scrollContainerRef={scrollContainerRef}
          onWheel={handleUserScrollGesture}
          onTouchMove={handleUserScrollGesture}
          isLoadingSessionMessages={isLoadingSessionMessages}
          isProcessing={isProcessing}
          hasActivityIndicator={hasActivityIndicator}
          chatMessages={chatMessages}
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={(nextProvider) => setProvider(nextProvider as Provider)}
          textareaRef={textareaRef}
          claudeModel={claudeModel}
          setClaudeModel={setClaudeModel}
          cursorModel={cursorModel}
          setCursorModel={setCursorModel}
          codexModel={codexModel}
          setCodexModel={setCodexModel}
          opencodeModel={opencodeModel}
          setOpenCodeModel={setOpenCodeModel}
          providerModelCatalog={providerModelCatalog}
          providerModelActions={providerModelActions}
          providerModelsLoading={providerModelsLoading}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
          isLoadingMoreMessages={isLoadingMoreMessages}
          hasMoreMessages={hasMoreMessages}
          onLoadOlderMessages={loadOlderMessagesNow}
          topSentinelRef={setTopSentinel}
          historyLoadError={historyLoadError}
          onRetryHistoryLoad={retryHistoryLoad}
          transcriptMissing={transcriptMissing}
          totalMessages={totalMessages}
          loadAllMessages={loadAllMessages}
          sessionMessagesCount={chatMessages.length}
          visibleMessages={visibleMessages}
          allMessagesLoaded={allMessagesLoaded}
          isLoadingAllMessages={isLoadingAllMessages}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantToolPermission={handleGrantToolPermission}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          onRewindToMessage={provider === 'claude' && rewindSessionId ? handleRewindToMessage : undefined}
          selectedProject={selectedProject}
        />

        <div className="relative flex-shrink-0">
          {isUserScrolledUp && chatMessages.length > 0 && (
            <div className="pointer-events-none absolute -top-11 left-0 right-0 z-20 flex justify-center">
              <button
                type="button"
                onClick={scrollToBottomAndReset}
                aria-label={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
                className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-sm transition-all duration-200 hover:bg-accent hover:text-foreground"
                title={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
              >
                <ArrowDownIcon className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}

          <ChatComposer
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          activity={activityWithConnection}
          isLoading={isProcessing}
          onAbortSession={handleAbortSession}
          permissionMode={permissionMode}
          availablePermissionModes={availablePermissionModes}
          onSelectPermissionMode={(mode) => selectPermissionMode(mode as PermissionMode)}
          providerLabel={selectedProviderLabel}
          effort={currentProviderEffort}
          availableEffortOptions={currentProviderEffortOptions}
          onSelectEffort={handleSelectComposerEffort}
          model={currentProviderModel}
          availableModelOptions={currentProviderModelOptions}
          onSelectModel={handleSelectComposerModel}
          modelsLoading={providerModelsLoading}
          tokenBudget={tokenBudget}
          onShowTokenUsage={showCostModal}
          handoffStatus={handoffStatus}
          onStartHandoff={canHandoff ? startHandoff : undefined}
          onSubmit={handleSubmit}
          isDragActive={isDragActive}
          queuedDrafts={queuedDrafts}
          onEditQueuedDraft={editQueuedDraft}
          onDeleteQueuedDraft={deleteQueuedDraft}
          // Вставить сообщение в идущий ход умеет только Claude.
          onSendNowQueuedDraft={provider === 'claude' ? sendNowQueuedDraft : undefined}
          onMoveQueuedDraft={moveQueuedDraft}
          onClearQueuedDrafts={clearQueuedDrafts}
          attachedFiles={attachedFiles}
          onRemoveAttachment={(index) =>
            setAttachedFiles((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          uploadingFiles={uploadingFiles}
          fileErrors={fileErrors}
          showFileDropdown={showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={resetCommandMenuState}
          isCommandMenuOpen={showCommandMenu}
          frequentCommands={commandQuery ? [] : frequentCommands}
          getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
          getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
          openAttachmentPicker={openAttachmentPicker}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          textareaRef={textareaRef}
          input={input}
          onVoiceTranscript={handleVoiceTranscript}
          onInputChange={handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          isInputFocused={isInputFocused}
          onInputFocusChange={handleInputFocusChange}
          placeholder={t('input.placeholder', { provider: selectedProviderLabel })}
          isTextareaExpanded={isTextareaExpanded}
          sendByCtrlEnter={sendByCtrlEnter}
        />
        </div>
      </div>

      <CommandResultModal
        payload={commandModalPayload}
        onClose={closeCommandModal}
        providerModelCatalog={providerModelCatalog}
        providerModelActions={providerModelActions}
        activeProvider={provider}
        activeProviderModel={currentProviderModel}
        currentSessionId={currentSessionId || selectedSession?.id || null}
        onSelectProviderModel={selectProviderModel}
      />
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
