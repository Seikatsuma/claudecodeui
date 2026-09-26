import React, { lazy, Suspense, useEffect } from 'react';

import ChatInterface from '../../chat/view/ChatInterface';
import type { MainContentProps } from '../types/types';
import { useTaskMaster } from '../../../contexts/TaskMasterContext';
import { usePaletteOpsRegister } from '../../../contexts/PaletteOpsContext';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useFileOpenResolver } from '../../../hooks/useFileOpenResolver';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import type { Project } from '../../../types/app';


import MainContentHeader from './subcomponents/MainContentHeader';
import MainContentStateView from './subcomponents/MainContentStateView';
import ErrorBoundary from './ErrorBoundary';

/**
 * Панели, кроме чата, подгружаются по требованию.
 *
 * Раньше при открытии приложения браузер честно скачивал и выполнял ВСЁ:
 * терминал, редактор кода, панель Git, файловое дерево, браузерную панель и
 * панель задач — даже если человек за всю сессию не откроет ни одной из них.
 * Замер на телефонном экране: почти десять секунд заблокированного главного
 * потока при старте, одним куском на 3,8 секунды. Это и ощущается как
 * «сайт подвисает». Чат нужен всегда — он остаётся обычным импортом;
 * остальное грузится в тот момент, когда на вкладку действительно нажали.
 */
const FileTree = lazy(() => import('../../file-tree/view/FileTree'));
const StandaloneShell = lazy(() => import('../../standalone-shell/view/StandaloneShell'));
const GitPanel = lazy(() => import('../../git-panel/view/GitPanel'));
const PluginTabContent = lazy(() => import('../../plugins/view/PluginTabContent'));
const BrowserUsePanel = lazy(() =>
  import('../../browser-use').then((m) => ({ default: m.BrowserUsePanel })),
);
const TaskMasterPanel = lazy(() =>
  import('../../task-master').then((m) => ({ default: m.TaskMasterPanel })),
);
const EditorSidebar = lazy(() => import('../../code-editor/view/EditorSidebar'));

/** Пока кусок панели летит по сети — короткая надпись вместо пустоты. */
function PanelFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
      Загружаю…
    </div>
  );
}


type TaskMasterContextValue = {
  currentProject?: Project | null;
  setCurrentProject?: ((project: Project) => void) | null;
};

function MainContent({
  projects,
  selectedProject,
  selectedSession,
  activeTab,
  terminals = [],
  activeTerminalId = null,
  setActiveTab,
  shouldShowTasksTab,
  shouldShowBrowserTab,
  ws,
  sendMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onInputFocusChange,
  onSessionProcessing,
  onSessionIdle,
  processingSessions,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  externalMessageUpdate,
  newSessionTrigger,
  onStartNewChat,
  onProjectSelect,
  onSessionSelect,
  onProjectsRefresh,
  onSessionArchived,
  onSessionRestored,
  attentionSessionIds,
}: MainContentProps) {
  const { preferences } = useUiPreferences();
  const { showRawParameters, showThinking, sendByCtrlEnter } = preferences;

  const { currentProject, setCurrentProject } = useTaskMaster() as TaskMasterContextValue;
  // Raw preference (independent of `shouldShowTasksTab`, which also gates on
  // TaskMaster actually being installed): the "view all tasks" chat link only
  // needs to know the user has tasks turned on.
  const { tasksEnabled } = useTasksSettings() as { tasksEnabled: boolean };

  const {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  } = useEditorSidebar({
    selectedProject,
    isMobile,
  });

  // Resolves bare/partial file references (e.g. links inside chat messages) to
  // real project files before opening them in the in-app editor.
  const resolvedFileOpen = useFileOpenResolver(selectedProject, handleFileOpen);

  useEffect(() => {
    // Identify projects by DB `projectId`; the TaskMaster context uses the
    // same identifier to key its internal maps.
    const selectedProjectId = selectedProject?.projectId;
    const currentProjectId = currentProject?.projectId;

    if (selectedProject && selectedProjectId !== currentProjectId) {
      setCurrentProject?.(selectedProject);
    }
  }, [selectedProject, currentProject?.projectId, setCurrentProject]);

  useEffect(() => {
    if (!shouldShowTasksTab && activeTab === 'tasks') {
      setActiveTab('chat');
    }
  }, [shouldShowTasksTab, activeTab, setActiveTab]);

  useEffect(() => {
    if (!shouldShowBrowserTab && activeTab === 'browser') {
      setActiveTab('chat');
    }
  }, [shouldShowBrowserTab, activeTab, setActiveTab]);

  usePaletteOpsRegister({
    openFile: (filePath: string) => {
      setActiveTab('files');
      handleFileOpen(filePath);
    },
    // Opens the editor side panel in place, keeping the current tab (e.g. chat).
    openFileInEditor: (filePath: string) => {
      resolvedFileOpen(filePath);
    },
  });

  if (isLoading) {
    return (
      <MainContentStateView
        mode="loading"
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        projects={projects}
        onProjectSelect={onProjectSelect}
        onSessionSelect={onSessionSelect}
        onStartNewChat={onStartNewChat}
        processingSessions={processingSessions}
        attentionSessionIds={attentionSessionIds}
      />
    );
  }

  // Окно командной строки открыли с главного экрана, когда чат не выбран:
  // показываем окно в его папке, а не заставку поверх него.
  const activeTerminalProject = activeTerminalId
    ? projects.find((candidate) => candidate.projectId === terminals.find((term) => term.id === activeTerminalId)?.projectId)
    : undefined;
  if (!selectedProject && activeTerminalProject) {
    selectedProject = activeTerminalProject;
  }

  if (!selectedProject) {
    return (
      <MainContentStateView
        mode="empty"
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        projects={projects}
        onProjectSelect={onProjectSelect}
        onSessionSelect={onSessionSelect}
        onStartNewChat={onStartNewChat}
        processingSessions={processingSessions}
        attentionSessionIds={attentionSessionIds}
      />
    );
  }

  return (
    // flex-1 + min-h-0, not h-full: this sits in a flex column directly under
    // SessionTabsBar (see AppContent), so `height: 100%` resolved against the
    // WHOLE column and pushed this block past the bottom of the screen by
    // exactly the height of that tab strip. Everything below - including the
    // composer's button row - was then clipped by the ancestors' overflow
    // hidden, with no way to scroll to it. It only showed up once at least one
    // session tab existed, which is why the layout looked fine at first and
    // "slid out of frame" later. flex-1 takes the space that is actually left.
    <div className="flex min-h-0 flex-1 flex-col">
      <MainContentHeader
        activeTab={activeTab}
        terminalTitle={terminals.find((term) => term.id === activeTerminalId)?.title ?? null}
        terminalProjectName={(() => {
          // Подпись под окном — папка САМОГО окна, а не открытого чата: окно
          // остаётся там, где открылось, даже если потом выбрали другой чат.
          const term = terminals.find((candidate) => candidate.id === activeTerminalId);
          if (!term) return null;
          return (projects.find((candidate) => candidate.projectId === term.projectId) ?? selectedProject).displayName;
        })()}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        shouldShowTasksTab={shouldShowTasksTab}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        onSessionArchived={onSessionArchived}
        onSessionRestored={onSessionRestored}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className={`flex min-h-0 min-w-[200px] flex-col overflow-hidden ${editorExpanded ? 'hidden' : ''} flex-1`}>
          <div className={`h-full ${activeTab === 'chat' && activeTerminalId === null ? 'block' : 'hidden'}`}>
            <ErrorBoundary showDetails>
              <ChatInterface
                isActive={activeTab === 'chat' && activeTerminalId === null}
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                ws={ws}
                sendMessage={sendMessage}
                onFileOpen={handleFileOpen}
                onInputFocusChange={onInputFocusChange}
                onSessionProcessing={onSessionProcessing}
                onSessionIdle={onSessionIdle}
                processingSessions={processingSessions}
                onNavigateToSession={onNavigateToSession}
                onSessionEstablished={onSessionEstablished}
                onShowSettings={onShowSettings}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
                sendByCtrlEnter={sendByCtrlEnter}
                externalMessageUpdate={externalMessageUpdate}
                newSessionTrigger={newSessionTrigger}
                onStartNewChat={onStartNewChat}
                onShowAllTasks={tasksEnabled ? () => setActiveTab('tasks') : null}
              />
            </ErrorBoundary>
          </div>

          {activeTerminalId === null && activeTab === 'files' && (
            <div className="h-full overflow-hidden">
              <Suspense fallback={<PanelFallback />}>
                <FileTree selectedProject={selectedProject} onFileOpen={handleFileOpen} />
              </Suspense>
            </div>
          )}

          {/*
            Окна командной строки.

            Каждое открытое окно остаётся на месте, даже когда смотришь чат:
            оно прячется, но не размонтируется. Иначе переключение на чат
            обрывало бы соединение и убивало всё, что в нём запущено — а Егор
            просил именно «как дополнительный чат», куда можно вернуться.

            Сеанс переписки сюда не передаётся: это обычная оболочка в каталоге
            проекта, а не продолжение конкретного разговора.
          */}
          {terminals.map((term) => {
            const project =
              projects.find((candidate) => candidate.projectId === term.projectId) ?? selectedProject;

            return (
              <div
                key={term.id}
                className={`h-full w-full overflow-hidden ${term.id === activeTerminalId ? 'block' : 'hidden'}`}
              >
                <Suspense fallback={<PanelFallback />}>
                  <StandaloneShell
                    project={project}
                    session={null}
                    terminalId={term.id}
                    isPlainShell
                    showHeader={false}
                    isActive={term.id === activeTerminalId}
                  />
                </Suspense>
              </div>
            );
          })}

          {activeTerminalId === null && activeTab === 'git' && (
            <div className="h-full overflow-hidden">
              <Suspense fallback={<PanelFallback />}>
                <GitPanel
                  selectedProject={selectedProject}
                  isMobile={isMobile}
                  onFileOpen={handleFileOpen}
                  onProjectSelect={onProjectSelect}
                  onProjectsRefresh={onProjectsRefresh}
                />
              </Suspense>
            </div>
          )}

          {shouldShowTasksTab && (
            <Suspense fallback={null}>
              <TaskMasterPanel isVisible={activeTerminalId === null && activeTab === 'tasks'} />
            </Suspense>
          )}

          {activeTerminalId === null && shouldShowBrowserTab && activeTab === 'browser' && (
            <div className="h-full overflow-hidden">
              <Suspense fallback={<PanelFallback />}>
                <BrowserUsePanel isVisible={activeTab === 'browser'} onShowSettings={onShowSettings} />
              </Suspense>
            </div>
          )}

          {activeTerminalId === null && activeTab.startsWith('plugin:') && (
            <div className="h-full overflow-hidden">
              <Suspense fallback={<PanelFallback />}>
                <PluginTabContent
                  pluginName={activeTab.replace('plugin:', '')}
                  selectedProject={selectedProject}
                  selectedSession={selectedSession}
                />
              </Suspense>
            </div>
          )}
        </div>

        {editingFile && (
        <Suspense fallback={null}>
        <EditorSidebar
          editingFile={editingFile}
          isMobile={isMobile}
          editorExpanded={editorExpanded}
          editorWidth={editorWidth}
          hasManualWidth={hasManualWidth}
          resizeHandleRef={resizeHandleRef}
          onResizeStart={handleResizeStart}
          onCloseEditor={handleCloseEditor}
          onToggleEditorExpand={handleToggleEditorExpand}
          projectPath={selectedProject.path}
          fillSpace={activeTab === 'files'}
        />
        </Suspense>
        )}
      </div>
    </div>
  );
}

export default React.memo(MainContent);
