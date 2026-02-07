import { html, nothing } from "lit";
import type { AppViewState } from "./app-view-state";
import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway";
import type { UiSettings } from "./storage";
import type { ThemeMode } from "./theme";
import type { ThemeTransitionContext } from "./theme-transition";
import type {
  ConfigSnapshot,
  CronJob,
  CronRunLogEntry,
  CronStatus,
  HealthSnapshot,
  LogEntry,
  LogLevel,
  PresenceEntry,
  ChannelsStatusSnapshot,
  SessionsListResult,
  SkillStatusReport,
  StatusSummary,
} from "./types";
import type { ChatQueueItem, CronFormState } from "./ui-types";
import { parseAgentSessionKey } from "../../../src/routing/session-key.js";
import { OpenClawApp } from "./app";
import { refreshChatAvatar } from "./app-chat";
import { renderChatControls, renderTab, renderThemeToggle } from "./app-render.helpers";
import { syncUrlWithSessionKey } from "./app-settings";
import { loadChannels } from "./controllers/channels";
import { ChatState, loadChatHistory } from "./controllers/chat";
import {
  applyConfig,
  loadConfig,
  runUpdate,
  saveConfig,
  updateConfigFormValue,
  removeConfigFormValue,
} from "./controllers/config";
import {
  loadCronRuns,
  toggleCronJob,
  runCronJob,
  removeCronJob,
  addCronJob,
} from "./controllers/cron";
import { loadDebug, callDebugMethod } from "./controllers/debug";
import {
  approveDevicePairing,
  loadDevices,
  rejectDevicePairing,
  revokeDeviceToken,
  rotateDeviceToken,
} from "./controllers/devices";
import {
  loadExecApprovals,
  removeExecApprovalsFormValue,
  saveExecApprovals,
  updateExecApprovalsFormValue,
} from "./controllers/exec-approvals";
import { loadLogs } from "./controllers/logs";
import { loadNodes } from "./controllers/nodes";
import { loadPresence } from "./controllers/presence";
import { deleteSession, loadSessions, patchSession } from "./controllers/sessions";
import {
  installSkill,
  loadSkills,
  saveSkillApiKey,
  updateSkillEdit,
  updateSkillEnabled,
  type SkillMessage,
} from "./controllers/skills";
import { icons } from "./icons";
import {
  TAB_GROUPS,
  iconForTab,
  pathForTab,
  subtitleForTab,
  titleForTab,
  type Tab,
} from "./navigation";
import { humanizeSessionKey } from "./session-humanize";
import { renderChannels } from "./views/channels";
import { renderChat } from "./views/chat";
import { renderConfig } from "./views/config";
import { renderCron } from "./views/cron";
import { renderDebug } from "./views/debug";
import { renderExecApprovalPrompt } from "./views/exec-approval";
import { renderGatewayUrlConfirmation } from "./views/gateway-url-confirmation";
import { renderInstances } from "./views/instances";
import { renderLogs } from "./views/logs";
import { renderNodes } from "./views/nodes";
import { renderOverview } from "./views/overview";
import { renderSessions } from "./views/sessions";
import { renderSkills } from "./views/skills";

const AVATAR_DATA_RE = /^data:/i;
const AVATAR_HTTP_RE = /^https?:\/\//i;

function resolveAssistantAvatarUrl(state: AppViewState): string | undefined {
  const list = state.agentsList?.agents ?? [];
  const parsed = parseAgentSessionKey(state.sessionKey);
  const agentId = parsed?.agentId ?? state.agentsList?.defaultId ?? "main";
  const agent = list.find((entry) => entry.id === agentId);
  const identity = agent?.identity;
  const candidate = identity?.avatarUrl ?? identity?.avatar;
  if (!candidate) return undefined;
  if (AVATAR_DATA_RE.test(candidate) || AVATAR_HTTP_RE.test(candidate)) return candidate;
  return identity?.avatarUrl;
}

export function renderApp(state: AppViewState) {
  const presenceCount = state.presenceEntries.length;
  const sessionsCount = state.sessionsResult?.count ?? null;
  const cronNext = state.cronStatus?.nextWakeAtMs ?? null;
  const chatDisabledReason = state.connected ? null : "Disconnected from gateway.";
  const isChat = state.tab === "chat";
  const chatFocus = isChat && (state.settings.chatFocusMode || state.onboarding);
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const assistantAvatarUrl = resolveAssistantAvatarUrl(state);
  const chatAvatarUrl = state.chatAvatarUrl ?? assistantAvatarUrl ?? null;

  // Status bar data
  const modelName = resolveModelName(state);
  const contextInfo = resolveContextInfo(state);
  const honeyInfo = resolveHoneyInfo(state);
  const sessionShort =
    state.sessionKey.length > 12 ? `SP-${state.sessionKey.slice(-5)}` : state.sessionKey;

  return html`
    <div class="shell ${isChat ? "shell--chat" : ""} ${chatFocus ? "shell--chat-focus" : ""} ${state.settings.navCollapsed ? "shell--nav-collapsed" : ""} ${state.onboarding ? "shell--onboarding" : ""}">
      <header class="topbar">
        <div class="topbar-left">
          <button
            class="nav-collapse-toggle splinter-hamburger"
            @click=${() =>
              state.applySettings({
                ...state.settings,
                navCollapsed: !state.settings.navCollapsed,
              })}
            title="${state.settings.navCollapsed ? "Expand sidebar" : "Collapse sidebar"}"
            aria-label="${state.settings.navCollapsed ? "Expand sidebar" : "Collapse sidebar"}"
          >
            <span class="nav-collapse-toggle__icon">${icons.menu}</span>
          </button>
          ${
            isChat
              ? renderChatChannelIndicator(state)
              : html`
                  <div class="brand">
                    <div class="brand-text">
                      <div class="brand-title">SPLINTER</div>
                      <div class="brand-sub">Gateway Dashboard</div>
                    </div>
                  </div>
                `
          }
        </div>
        <div class="topbar-status">
          ${
            isChat
              ? html`
            ${renderTopbarStatus(state)}
            ${renderHeaderControls(state)}
          `
              : html`
            <div class="pill">
              <span class="statusDot ${state.connected ? "ok" : ""}"></span>
              <span>Health</span>
              <span class="mono">${state.connected ? "OK" : "Offline"}</span>
            </div>
          `
          }
          ${isChat ? nothing : renderThemeToggle(state)}
        </div>
      </header>
      <aside class="nav ${state.settings.navCollapsed ? "nav--collapsed" : ""}">
        <div class="splinter-brand">
          <div class="splinter-brand__logo">
            <img src="https://brand-assets.unrealagent.ai/splinter/splinter-logo.svg" alt="Splinter" />
          </div>
          <div class="splinter-brand__text">
            <div class="splinter-brand__name">Splinter</div>
            <div class="splinter-brand__sub">${modelName} · 1M context</div>
          </div>
        </div>
        ${renderSidebarChannels(state)}
        ${TAB_GROUPS.map((group) => {
          const isGroupCollapsed = state.settings.navGroupsCollapsed[group.label] ?? false;
          const hasActiveTab = group.tabs.some((tab) => tab === state.tab);
          return html`
            <div class="nav-group ${isGroupCollapsed && !hasActiveTab ? "nav-group--collapsed" : ""}">
              <button
                class="nav-label"
                @click=${() => {
                  const next = { ...state.settings.navGroupsCollapsed };
                  next[group.label] = !isGroupCollapsed;
                  state.applySettings({
                    ...state.settings,
                    navGroupsCollapsed: next,
                  });
                }}
                aria-expanded=${!isGroupCollapsed}
              >
                <span class="nav-label__text">${group.label}</span>
                <span class="nav-label__chevron">${isGroupCollapsed ? "+" : "−"}</span>
              </button>
              <div class="nav-group__items">
                ${group.tabs.map((tab) => renderTab(state, tab))}
              </div>
            </div>
          `;
        })}
        <div class="nav-group nav-group--links">
          <div class="nav-label nav-label--static">
            <span class="nav-label__text">Resources</span>
          </div>
          <div class="nav-group__items">
            <a
              class="nav-item nav-item--external"
              href="https://docs.openclaw.ai"
              target="_blank"
              rel="noreferrer"
              title="Docs (opens in new tab)"
            >
              <span class="nav-item__icon" aria-hidden="true">${icons.book}</span>
              <span class="nav-item__text">Docs</span>
            </a>
          </div>
        </div>
      </aside>
      <main class="content ${isChat ? "content--chat" : ""}">
        ${
          isChat
            ? html`
          <section class="content-header content-header--chat">
            <div class="page-meta">
              ${state.lastError ? html`<div class="pill danger">${state.lastError}</div>` : nothing}
              ${renderChatControls(state)}
            </div>
          </section>
        `
            : html`
          <section class="content-header">
            <div>
              <div class="page-title">${titleForTab(state.tab)}</div>
              <div class="page-sub">${subtitleForTab(state.tab)}</div>
            </div>
            <div class="page-meta">
              ${state.lastError ? html`<div class="pill danger">${state.lastError}</div>` : nothing}
            </div>
          </section>
        `
        }

        ${
          state.tab === "overview"
            ? renderOverview({
                connected: state.connected,
                hello: state.hello,
                settings: state.settings,
                password: state.password,
                lastError: state.lastError,
                presenceCount,
                sessionsCount,
                cronEnabled: state.cronStatus?.enabled ?? null,
                cronNext,
                lastChannelsRefresh: state.channelsLastSuccess,
                onSettingsChange: (next) => state.applySettings(next),
                onPasswordChange: (next) => (state.password = next),
                onSessionKeyChange: (next) => {
                  state.sessionKey = next;
                  state.chatMessage = "";
                  state.resetToolStream();
                  state.applySettings({
                    ...state.settings,
                    sessionKey: next,
                    lastActiveSessionKey: next,
                  });
                  void state.loadAssistantIdentity();
                },
                onConnect: () => state.connect(),
                onRefresh: () => state.loadOverview(),
              })
            : nothing
        }

        ${
          state.tab === "channels"
            ? renderChannels({
                connected: state.connected,
                loading: state.channelsLoading,
                snapshot: state.channelsSnapshot,
                lastError: state.channelsError,
                lastSuccessAt: state.channelsLastSuccess,
                whatsappMessage: state.whatsappLoginMessage,
                whatsappQrDataUrl: state.whatsappLoginQrDataUrl,
                whatsappConnected: state.whatsappLoginConnected,
                whatsappBusy: state.whatsappBusy,
                configSchema: state.configSchema,
                configSchemaLoading: state.configSchemaLoading,
                configForm: state.configForm,
                configUiHints: state.configUiHints,
                configSaving: state.configSaving,
                configFormDirty: state.configFormDirty,
                nostrProfileFormState: state.nostrProfileFormState,
                nostrProfileAccountId: state.nostrProfileAccountId,
                onRefresh: (probe) => loadChannels(state, probe),
                onWhatsAppStart: (force) => state.handleWhatsAppStart(force),
                onWhatsAppWait: () => state.handleWhatsAppWait(),
                onWhatsAppLogout: () => state.handleWhatsAppLogout(),
                onConfigPatch: (path, value) => updateConfigFormValue(state, path, value),
                onConfigSave: () => state.handleChannelConfigSave(),
                onConfigReload: () => state.handleChannelConfigReload(),
                onNostrProfileEdit: (accountId, profile) =>
                  state.handleNostrProfileEdit(accountId, profile),
                onNostrProfileCancel: () => state.handleNostrProfileCancel(),
                onNostrProfileFieldChange: (field, value) =>
                  state.handleNostrProfileFieldChange(field, value),
                onNostrProfileSave: () => state.handleNostrProfileSave(),
                onNostrProfileImport: () => state.handleNostrProfileImport(),
                onNostrProfileToggleAdvanced: () => state.handleNostrProfileToggleAdvanced(),
              })
            : nothing
        }

        ${
          state.tab === "instances"
            ? renderInstances({
                loading: state.presenceLoading,
                entries: state.presenceEntries,
                lastError: state.presenceError,
                statusMessage: state.presenceStatus,
                onRefresh: () => loadPresence(state),
              })
            : nothing
        }

        ${
          state.tab === "sessions"
            ? renderSessions({
                loading: state.sessionsLoading,
                result: state.sessionsResult,
                error: state.sessionsError,
                activeMinutes: state.sessionsFilterActive,
                limit: state.sessionsFilterLimit,
                includeGlobal: state.sessionsIncludeGlobal,
                includeUnknown: state.sessionsIncludeUnknown,
                basePath: state.basePath,
                onFiltersChange: (next) => {
                  state.sessionsFilterActive = next.activeMinutes;
                  state.sessionsFilterLimit = next.limit;
                  state.sessionsIncludeGlobal = next.includeGlobal;
                  state.sessionsIncludeUnknown = next.includeUnknown;
                },
                onRefresh: () => loadSessions(state),
                onPatch: (key, patch) => patchSession(state, key, patch),
                onDelete: (key) => deleteSession(state, key),
              })
            : nothing
        }

        ${
          state.tab === "cron"
            ? renderCron({
                basePath: state.basePath,
                loading: state.cronLoading,
                status: state.cronStatus,
                jobs: state.cronJobs,
                error: state.cronError,
                busy: state.cronBusy,
                form: state.cronForm,
                channels: state.channelsSnapshot?.channelMeta?.length
                  ? state.channelsSnapshot.channelMeta.map((entry) => entry.id)
                  : (state.channelsSnapshot?.channelOrder ?? []),
                channelLabels: state.channelsSnapshot?.channelLabels ?? {},
                channelMeta: state.channelsSnapshot?.channelMeta ?? [],
                runsJobId: state.cronRunsJobId,
                runs: state.cronRuns,
                onFormChange: (patch) => (state.cronForm = { ...state.cronForm, ...patch }),
                onRefresh: () => state.loadCron(),
                onAdd: () => addCronJob(state),
                onToggle: (job, enabled) => toggleCronJob(state, job, enabled),
                onRun: (job) => runCronJob(state, job),
                onRemove: (job) => removeCronJob(state, job),
                onLoadRuns: (jobId) => loadCronRuns(state, jobId),
              })
            : nothing
        }

        ${
          state.tab === "skills"
            ? renderSkills({
                loading: state.skillsLoading,
                report: state.skillsReport,
                error: state.skillsError,
                filter: state.skillsFilter,
                edits: state.skillEdits,
                messages: state.skillMessages,
                busyKey: state.skillsBusyKey,
                onFilterChange: (next) => (state.skillsFilter = next),
                onRefresh: () => loadSkills(state, { clearMessages: true }),
                onToggle: (key, enabled) => updateSkillEnabled(state, key, enabled),
                onEdit: (key, value) => updateSkillEdit(state, key, value),
                onSaveKey: (key) => saveSkillApiKey(state, key),
                onInstall: (skillKey, name, installId) =>
                  installSkill(state, skillKey, name, installId),
              })
            : nothing
        }

        ${
          state.tab === "nodes"
            ? renderNodes({
                loading: state.nodesLoading,
                nodes: state.nodes,
                devicesLoading: state.devicesLoading,
                devicesError: state.devicesError,
                devicesList: state.devicesList,
                configForm:
                  state.configForm ??
                  (state.configSnapshot?.config as Record<string, unknown> | null),
                configLoading: state.configLoading,
                configSaving: state.configSaving,
                configDirty: state.configFormDirty,
                configFormMode: state.configFormMode,
                execApprovalsLoading: state.execApprovalsLoading,
                execApprovalsSaving: state.execApprovalsSaving,
                execApprovalsDirty: state.execApprovalsDirty,
                execApprovalsSnapshot: state.execApprovalsSnapshot,
                execApprovalsForm: state.execApprovalsForm,
                execApprovalsSelectedAgent: state.execApprovalsSelectedAgent,
                execApprovalsTarget: state.execApprovalsTarget,
                execApprovalsTargetNodeId: state.execApprovalsTargetNodeId,
                onRefresh: () => loadNodes(state),
                onDevicesRefresh: () => loadDevices(state),
                onDeviceApprove: (requestId) => approveDevicePairing(state, requestId),
                onDeviceReject: (requestId) => rejectDevicePairing(state, requestId),
                onDeviceRotate: (deviceId, role, scopes) =>
                  rotateDeviceToken(state, { deviceId, role, scopes }),
                onDeviceRevoke: (deviceId, role) => revokeDeviceToken(state, { deviceId, role }),
                onLoadConfig: () => loadConfig(state),
                onLoadExecApprovals: () => {
                  const target =
                    state.execApprovalsTarget === "node" && state.execApprovalsTargetNodeId
                      ? { kind: "node" as const, nodeId: state.execApprovalsTargetNodeId }
                      : { kind: "gateway" as const };
                  return loadExecApprovals(state, target);
                },
                onBindDefault: (nodeId) => {
                  if (nodeId) {
                    updateConfigFormValue(state, ["tools", "exec", "node"], nodeId);
                  } else {
                    removeConfigFormValue(state, ["tools", "exec", "node"]);
                  }
                },
                onBindAgent: (agentIndex, nodeId) => {
                  const basePath = ["agents", "list", agentIndex, "tools", "exec", "node"];
                  if (nodeId) {
                    updateConfigFormValue(state, basePath, nodeId);
                  } else {
                    removeConfigFormValue(state, basePath);
                  }
                },
                onSaveBindings: () => saveConfig(state),
                onExecApprovalsTargetChange: (kind, nodeId) => {
                  state.execApprovalsTarget = kind;
                  state.execApprovalsTargetNodeId = nodeId;
                  state.execApprovalsSnapshot = null;
                  state.execApprovalsForm = null;
                  state.execApprovalsDirty = false;
                  state.execApprovalsSelectedAgent = null;
                },
                onExecApprovalsSelectAgent: (agentId) => {
                  state.execApprovalsSelectedAgent = agentId;
                },
                onExecApprovalsPatch: (path, value) =>
                  updateExecApprovalsFormValue(state, path, value),
                onExecApprovalsRemove: (path) => removeExecApprovalsFormValue(state, path),
                onSaveExecApprovals: () => {
                  const target =
                    state.execApprovalsTarget === "node" && state.execApprovalsTargetNodeId
                      ? { kind: "node" as const, nodeId: state.execApprovalsTargetNodeId }
                      : { kind: "gateway" as const };
                  return saveExecApprovals(state, target);
                },
              })
            : nothing
        }

        ${
          state.tab === "chat"
            ? renderChat({
                sessionKey: state.sessionKey,
                onSessionKeyChange: (next) => {
                  state.sessionKey = next;
                  state.chatMessage = "";
                  state.chatAttachments = [];
                  state.chatStream = null;
                  state.chatStreamStartedAt = null;
                  state.chatRunId = null;
                  state.chatQueue = [];
                  state.resetToolStream();
                  state.resetChatScroll();
                  state.applySettings({
                    ...state.settings,
                    sessionKey: next,
                    lastActiveSessionKey: next,
                  });
                  void state.loadAssistantIdentity();
                  void loadChatHistory(state);
                  void refreshChatAvatar(state);
                },
                thinkingLevel: state.chatThinkingLevel,
                showThinking,
                loading: state.chatLoading,
                sending: state.chatSending,
                compactionStatus: state.compactionStatus,
                assistantAvatarUrl: chatAvatarUrl,
                messages: state.chatMessages,
                toolMessages: state.chatToolMessages,
                stream: state.chatStream,
                streamStartedAt: state.chatStreamStartedAt,
                draft: state.chatMessage,
                queue: state.chatQueue,
                connected: state.connected,
                canSend: state.connected,
                disabledReason: chatDisabledReason,
                error: state.lastError,
                sessions: state.sessionsResult,
                focusMode: chatFocus,
                onRefresh: () => {
                  state.resetToolStream();
                  return Promise.all([loadChatHistory(state), refreshChatAvatar(state)]);
                },
                onToggleFocusMode: () => {
                  if (state.onboarding) return;
                  state.applySettings({
                    ...state.settings,
                    chatFocusMode: !state.settings.chatFocusMode,
                  });
                },
                onChatScroll: (event) => state.handleChatScroll(event),
                onDraftChange: (next) => (state.chatMessage = next),
                attachments: state.chatAttachments,
                onAttachmentsChange: (next) => (state.chatAttachments = next),
                onSend: () => state.handleSendChat(),
                canAbort: Boolean(state.chatRunId),
                onAbort: () => void state.handleAbortChat(),
                onQueueRemove: (id) => state.removeQueuedMessage(id),
                onNewSession: () => state.handleSendChat("/new", { restoreDraft: true }),
                onCompact: () => state.handleSendChat("/compact"),
                onRestart: () => state.handleSendChat("/restart"),
                toolbarExpanded: (state as any).chatToolbarExpanded !== false,
                onToggleToolbar: () => {
                  const cur = (state as any).chatToolbarExpanded !== false;
                  (state as any).chatToolbarExpanded = !cur;
                  state.requestUpdate();
                },
                // Sidebar props for tool output viewing
                sidebarOpen: state.sidebarOpen,
                sidebarContent: state.sidebarContent,
                sidebarError: state.sidebarError,
                splitRatio: state.splitRatio,
                onOpenSidebar: (content: string) => state.handleOpenSidebar(content),
                onCloseSidebar: () => state.handleCloseSidebar(),
                onSplitRatioChange: (ratio: number) => state.handleSplitRatioChange(ratio),
                assistantName: state.assistantName,
                assistantAvatar: state.assistantAvatar,
                // Voice input
                isListening: state.chatVoiceListening,
                onVoiceToggle: state.chatVoiceSupported
                  ? () => state.handleVoiceToggle()
                  : undefined,
              })
            : nothing
        }

        ${
          state.tab === "config"
            ? renderConfig({
                raw: state.configRaw,
                originalRaw: state.configRawOriginal,
                valid: state.configValid,
                issues: state.configIssues,
                loading: state.configLoading,
                saving: state.configSaving,
                applying: state.configApplying,
                updating: state.updateRunning,
                connected: state.connected,
                schema: state.configSchema,
                schemaLoading: state.configSchemaLoading,
                uiHints: state.configUiHints,
                formMode: state.configFormMode,
                formValue: state.configForm,
                originalValue: state.configFormOriginal,
                searchQuery: state.configSearchQuery,
                activeSection: state.configActiveSection,
                activeSubsection: state.configActiveSubsection,
                onRawChange: (next) => {
                  state.configRaw = next;
                },
                onFormModeChange: (mode) => (state.configFormMode = mode),
                onFormPatch: (path, value) => updateConfigFormValue(state, path, value),
                onSearchChange: (query) => (state.configSearchQuery = query),
                onSectionChange: (section) => {
                  state.configActiveSection = section;
                  state.configActiveSubsection = null;
                },
                onSubsectionChange: (section) => (state.configActiveSubsection = section),
                onReload: () => loadConfig(state),
                onSave: () => saveConfig(state),
                onApply: () => applyConfig(state),
                onUpdate: () => runUpdate(state),
              })
            : nothing
        }

        ${
          state.tab === "debug"
            ? renderDebug({
                loading: state.debugLoading,
                status: state.debugStatus,
                health: state.debugHealth,
                models: state.debugModels,
                heartbeat: state.debugHeartbeat,
                eventLog: state.eventLog,
                callMethod: state.debugCallMethod,
                callParams: state.debugCallParams,
                callResult: state.debugCallResult,
                callError: state.debugCallError,
                onCallMethodChange: (next) => (state.debugCallMethod = next),
                onCallParamsChange: (next) => (state.debugCallParams = next),
                onRefresh: () => loadDebug(state),
                onCall: () => callDebugMethod(state),
              })
            : nothing
        }

        ${
          state.tab === "logs"
            ? renderLogs({
                loading: state.logsLoading,
                error: state.logsError,
                file: state.logsFile,
                entries: state.logsEntries,
                filterText: state.logsFilterText,
                levelFilters: state.logsLevelFilters,
                autoFollow: state.logsAutoFollow,
                truncated: state.logsTruncated,
                onFilterTextChange: (next) => (state.logsFilterText = next),
                onLevelToggle: (level, enabled) => {
                  state.logsLevelFilters = { ...state.logsLevelFilters, [level]: enabled };
                },
                onToggleAutoFollow: (next) => (state.logsAutoFollow = next),
                onRefresh: () => loadLogs(state, { reset: true }),
                onExport: (lines, label) => state.exportLogs(lines, label),
                onScroll: (event) => state.handleLogsScroll(event),
              })
            : nothing
        }
      </main>
      ${
        isChat
          ? nothing
          : html`
        <div class="splinter-statusbar">
          <div class="splinter-statusbar__left">
            <span class="splinter-statusbar__model">
              <span class="splinter-statusbar__dot ${state.connected ? "splinter-statusbar__dot--ok" : ""}"></span>
              <span>🧠 ${modelName}</span>
            </span>
            <span class="splinter-statusbar__context">
              <span class="splinter-statusbar__context-label">Context:</span>
              <span class="splinter-statusbar__meter">
                <span class="splinter-statusbar__meter-fill ${contextInfo.colorClass}" style="width: ${contextInfo.percent}%"></span>
              </span>
              <span class="splinter-statusbar__context-pct ${contextInfo.colorClass}">${contextInfo.percent}%</span>
              <span class="splinter-statusbar__context-detail">(${contextInfo.used} / ${contextInfo.total})</span>
            </span>
          </div>
          <div class="splinter-statusbar__right">
            ${
              honeyInfo
                ? html`<span class="splinter-statusbar__honey">${icons.droplets} ${honeyInfo.injectLimit} / ${honeyInfo.totalTurns} turns</span>`
                : nothing
            }
            <span class="splinter-statusbar__session-id">ID: ${sessionShort}</span>
          </div>
        </div>
      `
      }
      ${renderExecApprovalPrompt(state)}
      ${renderGatewayUrlConfirmation(state)}
    </div>
  `;
}

// ── Status bar helpers ──────────────────────────────────────────

function resolveModelName(state: AppViewState): string {
  const hello = state.hello;
  if (!hello) return "Opus 4.6";
  const snapshot = hello.snapshot as Record<string, unknown> | undefined;
  const model = snapshot?.model as string | undefined;
  if (model) {
    // Clean up model name: "anthropic/claude-opus-4-6" → "Opus 4.6"
    const parts = model.split("/");
    const name = parts[parts.length - 1] ?? model;
    return name
      .replace("claude-", "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .replace(/(\d+) (\d+)/g, "$1.$2");
  }
  return "Opus 4.6";
}

type ContextInfo = {
  percent: number;
  used: string;
  total: string;
  colorClass: string;
};

function resolveContextInfo(state: AppViewState): ContextInfo {
  // Try to get context window info from the active session
  const session = state.sessionsResult?.sessions?.find((s) => s.key === state.sessionKey);
  const usage = session as Record<string, unknown> | undefined;
  // contextTokens = context window size, totalTokens = actual tokens used
  const totalTokens = typeof usage?.totalTokens === "number" ? usage.totalTokens : null;
  const contextUsed = totalTokens;
  const contextMax =
    typeof usage?.contextTokens === "number"
      ? usage.contextTokens
      : typeof usage?.contextMax === "number"
        ? usage.contextMax
        : 1_000_000;

  if (contextUsed !== null) {
    const pct = Math.min(100, Math.round((contextUsed / contextMax) * 100));
    return {
      percent: pct,
      used: formatTokenCount(contextUsed),
      total: formatTokenCount(contextMax),
      colorClass: pct < 50 ? "ctx-ok" : pct < 80 ? "ctx-warn" : "ctx-danger",
    };
  }

  return {
    percent: 11,
    used: "107k",
    total: "1.0M",
    colorClass: "ctx-ok",
  };
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function resolveHoneyInfo(
  state: AppViewState,
): { injectLimit: number; totalTurns: number; storage: string } | null {
  const hello = state.hello;
  if (!hello) return null;
  const snapshot = hello.snapshot as Record<string, unknown> | undefined;
  const honey = snapshot?.honey as
    | { connected?: boolean; totalTurns?: number; storage?: string; injectLimit?: number }
    | undefined;
  if (!honey?.connected) return null;
  return {
    injectLimit: honey.injectLimit ?? 30,
    totalTurns: honey.totalTurns ?? 0,
    storage: (honey.storage ?? "").replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "").trim(),
  };
}

// ── Topbar status (model + context + honey) ─────────────────

function renderTopbarStatus(state: AppViewState) {
  const modelName = resolveModelName(state);
  const contextInfo = resolveContextInfo(state);
  const honeyInfo = resolveHoneyInfo(state);

  return html`
    <div class="topbar-context">
      <span class="topbar-context__model">${modelName}</span>
      <span class="topbar-context__sep">·</span>
      <span class="topbar-context__label">CONTEXT</span>
      <span class="topbar-context__meter">
        <span class="topbar-context__meter-fill ${contextInfo.colorClass}" style="width: ${contextInfo.percent}%"></span>
      </span>
      <span class="topbar-context__pct ${contextInfo.colorClass}">${contextInfo.percent}%</span>
      <span class="topbar-context__detail">(${contextInfo.used} / ${contextInfo.total})</span>
      ${
        honeyInfo
          ? html`
        <span class="topbar-context__sep">·</span>
        <span class="topbar-context__honey-icon">${icons.droplets}</span>
        <span class="topbar-context__label">HONEY</span>
        <span class="topbar-context__meter">
          <span class="topbar-context__meter-fill topbar-context__meter-fill--honey" style="width: ${Math.min(100, Math.round((honeyInfo.injectLimit / Math.max(honeyInfo.totalTurns, 1)) * 100))}%"></span>
        </span>
        <span class="topbar-context__detail">${honeyInfo.injectLimit} / ${honeyInfo.totalTurns}</span>
        ${honeyInfo.storage ? html`<span class="topbar-context__honey-storage">${icons.cloud} ${honeyInfo.storage}</span>` : nothing}
      `
          : nothing
      }
    </div>
  `;
}

// ── Header controls (brain + voice) ──────────────────────────

function renderHeaderControls(state: AppViewState) {
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  return html`
    <button
      class="splinter-header-btn ${showThinking ? "splinter-header-btn--active" : ""}"
      @click=${() => {
        if (!state.onboarding) {
          state.applySettings({
            ...state.settings,
            chatShowThinking: !state.settings.chatShowThinking,
          });
        }
      }}
      title="Toggle extended thinking"
    >
      <span class="splinter-header-btn__icon">${icons.brain}</span>
    </button>
  `;
}

// ── Chat channel indicator ───────────────────────────────────

function renderChatChannelIndicator(state: AppViewState) {
  const humanized = humanizeSessionKey(state.sessionKey);
  return html`
    <div class="splinter-channel-indicator">
      <span class="splinter-channel-indicator__icon">${icons.wrench}</span>
      <span class="splinter-channel-indicator__name">${humanized.displayName}</span>
    </div>
  `;
}

// ── Sidebar channels ────────────────────────────────────────

function renderSidebarChannels(state: AppViewState) {
  const sessions = state.sessionsResult?.sessions ?? [];
  const hello = state.hello;
  const snapshot = hello?.snapshot as Record<string, unknown> | undefined;
  const mainSessionKey = (snapshot?.sessionDefaults as Record<string, unknown>)?.mainSessionKey as
    | string
    | undefined;

  // Group sessions by channel type
  const webchatSessions: Array<{ key: string; displayName: string }> = [];
  const slackSessions: Array<{ key: string; displayName: string }> = [];
  const otherSessions: Array<{ key: string; displayName: string }> = [];

  // Always include current session
  const seen = new Set<string>();

  const addSession = (key: string, row?: unknown) => {
    if (seen.has(key)) return;
    seen.add(key);
    const r = row as Record<string, unknown> | undefined;
    const labelHint =
      (r?.label as string) ||
      (r?.displayName as string) ||
      (r?.subject as string) ||
      (r?.room as string) ||
      undefined;
    const humanized = humanizeSessionKey(key, labelHint);
    const entry = { key, displayName: humanized.displayName };
    if (humanized.channelType === "slack") {
      slackSessions.push(entry);
    } else if (humanized.channelType === "webchat") {
      webchatSessions.push(entry);
    } else {
      otherSessions.push(entry);
    }
  };

  // Add main and current first
  if (mainSessionKey)
    addSession(
      mainSessionKey,
      sessions.find((s) => s.key === mainSessionKey),
    );
  addSession(
    state.sessionKey,
    sessions.find((s) => s.key === state.sessionKey),
  );

  // Add all sessions, filtering out threads and sub-agents
  for (const s of sessions) {
    // Skip sub-agent sessions
    if (s.key.includes("subagent")) continue;
    // Skip Slack thread sessions (contain :thread:)
    if (s.key.includes(":thread:")) continue;
    addSession(s.key, s);
  }

  const switchSession = (key: string) => {
    state.sessionKey = key;
    state.chatMessage = "";
    state.chatStream = null;
    (state as unknown as OpenClawApp).chatStreamStartedAt = null;
    state.chatRunId = null;
    (state as unknown as OpenClawApp).resetToolStream();
    (state as unknown as OpenClawApp).resetChatScroll();
    state.applySettings({
      ...state.settings,
      sessionKey: key,
      lastActiveSessionKey: key,
    });
    void state.loadAssistantIdentity();
    syncUrlWithSessionKey(
      state as unknown as Parameters<typeof syncUrlWithSessionKey>[0],
      key,
      true,
    );
    void loadChatHistory(state as unknown as ChatState);
    // Switch to chat tab if not already there
    if (state.tab !== "chat") {
      state.setTab("chat" as Tab);
    }
  };

  const renderChannelItem = (entry: { key: string; displayName: string }) => {
    const isActive = entry.key === state.sessionKey;
    const channelIcon = entry.key.includes("slack") ? icons.hash : icons.messageSquare;
    return html`
      <a
        class="nav-item ${isActive ? "active" : ""}"
        href="#"
        @click=${(e: Event) => {
          e.preventDefault();
          switchSession(entry.key);
        }}
        title=${entry.displayName}
      >
        <span class="nav-item__icon" aria-hidden="true">${channelIcon}</span>
        <span class="nav-item__text">${entry.displayName}</span>
      </a>
    `;
  };

  return html`
    ${
      webchatSessions.length
        ? html`
      <div class="nav-group">
        <div class="nav-label nav-label--static">
          <span class="nav-label__text">Webchat</span>
        </div>
        <div class="nav-group__items">
          ${webchatSessions.map(renderChannelItem)}
        </div>
      </div>
    `
        : nothing
    }
    ${
      slackSessions.length
        ? html`
      <div class="nav-group">
        <div class="nav-label nav-label--static">
          <span class="nav-label__text">Slack</span>
        </div>
        <div class="nav-group__items">
          ${slackSessions.map(renderChannelItem)}
        </div>
      </div>
    `
        : nothing
    }
    ${
      otherSessions.length
        ? html`
      <div class="nav-group">
        <div class="nav-label nav-label--static">
          <span class="nav-label__text">Other</span>
        </div>
        <div class="nav-group__items">
          ${otherSessions.map(renderChannelItem)}
        </div>
      </div>
    `
        : nothing
    }
  `;
}
