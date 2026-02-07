import { html, nothing } from "lit";
import type { ToolCard } from "../types/chat-types.ts";
import { icons } from "../icons.ts";
import { formatToolDetail, resolveToolDisplay } from "../tool-display.ts";
import { TOOL_INLINE_THRESHOLD } from "./constants.ts";
import { extractTextCached } from "./message-extract.ts";
import { isToolResultMessage } from "./message-normalizer.ts";
import { formatToolOutputForSidebar, getTruncatedPreview } from "./tool-helpers.ts";

export function extractToolCards(message: unknown): ToolCard[] {
  const m = message as Record<string, unknown>;
  const content = normalizeContent(m.content);
  const cards: ToolCard[] = [];

  for (const item of content) {
    const kind = (typeof item.type === "string" ? item.type : "").toLowerCase();
    const isToolCall =
      ["toolcall", "tool_call", "tooluse", "tool_use"].includes(kind) ||
      (typeof item.name === "string" && item.arguments != null);
    if (isToolCall) {
      cards.push({
        kind: "call",
        name: (item.name as string) ?? "tool",
        args: coerceArgs(item.arguments ?? item.args),
      });
    }
  }

  for (const item of content) {
    const kind = (typeof item.type === "string" ? item.type : "").toLowerCase();
    if (kind !== "toolresult" && kind !== "tool_result") {
      continue;
    }
    const text = extractToolText(item);
    const name = typeof item.name === "string" ? item.name : "tool";
    cards.push({ kind: "result", name, text });
  }

  if (isToolResultMessage(message) && !cards.some((card) => card.kind === "result")) {
    const name =
      (typeof m.toolName === "string" && m.toolName) ||
      (typeof m.tool_name === "string" && m.tool_name) ||
      "tool";
    const text = extractTextCached(message) ?? undefined;
    cards.push({ kind: "result", name, text });
  }

  return cards;
}

export function renderToolCardSidebar(card: ToolCard, onOpenSidebar?: (content: string) => void) {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
  const hasText = Boolean(card.text?.trim());

  const canClick = Boolean(onOpenSidebar);
  const handleSidebarClick = canClick
    ? (e: Event) => {
        e.stopPropagation();
        if (hasText) {
          onOpenSidebar!(formatToolOutputForSidebar(card.text!));
          return;
        }
        const info = `## ${display.label}\n\n${
          detail ? `**Command:** \`${detail}\`\n\n` : ""
        }*No output — tool completed successfully.*`;
        onOpenSidebar!(info);
      }
    : undefined;

  // Tool calls in history are always completed — only the live tool stream shows "Processing"
  const isRunning = false;
  const isError =
    hasText &&
    (card.text?.toLowerCase().includes("error") || card.text?.toLowerCase().includes("failed"));

  // Status badge
  const statusBadge = isRunning
    ? html`
        <span class="tool-chevron__badge tool-chevron__badge--running">Processing...</span>
      `
    : isError
      ? html`
          <span class="tool-chevron__badge tool-chevron__badge--error">Error</span>
        `
      : html`
          <span class="tool-chevron__badge tool-chevron__badge--success">Success</span>
        `;

  // Status icon
  const statusIcon = isRunning
    ? html`<span class="tool-chevron__status-icon tool-chevron__status-icon--running">${icons.loader}</span>`
    : isError
      ? html`<span class="tool-chevron__status-icon tool-chevron__status-icon--error">${icons.xCircle}</span>`
      : html`<span class="tool-chevron__status-icon tool-chevron__status-icon--success">${icons.checkCircle}</span>`;

  // Detail line for expanded view
  const expandedContent = hasText
    ? html`<div class="tool-chevron__output mono">${getTruncatedPreview(card.text!)}</div>`
    : detail
      ? html`<div class="tool-chevron__output mono">${detail}</div>`
      : html`
          <div class="tool-chevron__output muted">Completed — no output</div>
        `;

  return html`
    <details class="tool-chevron ${isRunning ? "tool-chevron--running" : ""}" ?open=${isRunning}>
      <summary
        class="tool-chevron__summary"
        @click=${(e: Event) => {
          // Allow default details toggle behavior
        }}
      >
        <div class="tool-chevron__left">
          ${statusIcon}
          <span class="tool-chevron__name">${display.label}</span>
          ${detail && !isRunning ? html`<span class="tool-chevron__detail">${detail}</span>` : nothing}
          ${statusBadge}
        </div>
        <div class="tool-chevron__right">
          ${
            canClick && hasText
              ? html`<button class="tool-chevron__view-btn" @click=${handleSidebarClick} title="View full output">View</button>`
              : nothing
          }
          <span class="tool-chevron__arrow">${icons.chevronRight}</span>
        </div>
      </summary>
      <div class="tool-chevron__body">
        ${expandedContent}
      </div>
    </details>
  `;
}

function normalizeContent(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(Boolean) as Array<Record<string, unknown>>;
}

function coerceArgs(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractToolText(item: Record<string, unknown>): string | undefined {
  if (typeof item.text === "string") {
    return item.text;
  }
  if (typeof item.content === "string") {
    return item.content;
  }
  return undefined;
}
