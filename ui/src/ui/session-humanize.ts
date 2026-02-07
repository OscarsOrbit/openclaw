/**
 * Humanize session keys for display.
 * Turns cryptic keys like "agent:main:slack:channel:c0ad0v8p4p4" into
 * friendlier names like "#splinter" or "Webchat".
 */

export type HumanizedSession = {
  /** Human-readable display name */
  displayName: string;
  /** Channel type: "webchat" | "slack" | "discord" | "telegram" | "whatsapp" | "unknown" */
  channelType: string;
  /** The raw channel ID, if extracted */
  channelId?: string;
  /** Icon hint: "chat" | "slack" | "discord" | "telegram" | "hash" */
  iconHint: string;
};

const CHANNEL_NAMES: Record<string, string> = {
  c0ad0v8p4p4: "#splinter",
  d0acvqb3x24: "DM: Oscar",
  c0abzfwaaky: "#splinter-chat",
  c08guf2c75g: "#alerts",
};

/** Case-insensitive channel name lookup. Strips prefixes like "channel:", "g-". */
function lookupChannelName(id: string): string | undefined {
  const normalized = id.toLowerCase().replace(/^(channel:|g-)/, "");
  return CHANNEL_NAMES[normalized];
}

export function humanizeSessionKey(key: string, label?: string): HumanizedSession {
  if (label?.trim()) {
    const channelType = detectChannelType(key);
    let displayName = label.trim();
    // Strip channel type prefixes like "slack:" or "webchat:"
    displayName = displayName.replace(/^(slack|webchat|discord|telegram|whatsapp):/i, "");
    // Strip "g-" prefix (thread/group indicator)
    displayName = displayName.replace(/^g-/, "#");
    return {
      displayName,
      channelType,
      iconHint: iconForChannelType(channelType),
    };
  }

  // Try parsing agent session key format: agent:{agentId}:{channel}:{type}:{id}
  const parts = key.split(":");

  // Direct "main" key
  if (key === "main") {
    return {
      displayName: "Main",
      channelType: "webchat",
      iconHint: "chat",
    };
  }

  // Format: slack:g-{id} or slack:{id}
  if (parts[0] === "slack") {
    const channelId = parts.slice(1).join(":");
    const friendlyName = lookupChannelName(channelId) ?? channelId;
    return {
      displayName: friendlyName,
      channelType: "slack",
      channelId,
      iconHint: "slack",
    };
  }

  // Format: webchat:{id}
  if (parts[0] === "webchat") {
    return {
      displayName: "Webchat",
      channelType: "webchat",
      iconHint: "chat",
    };
  }

  // Format: agent:{agentId}:{channel}:{type}:{id}
  if (parts[0] === "agent" && parts.length >= 3) {
    const channel = parts[2]; // slack, webchat, etc.
    const channelId = parts.slice(3).join(":");

    if (channel === "webchat") {
      return {
        displayName: "Webchat",
        channelType: "webchat",
        iconHint: "chat",
      };
    }

    if (channel === "slack") {
      const type = parts[3]; // channel, dm, etc.
      const id = parts.slice(4).join(":");
      const friendlyName = lookupChannelName(id) ?? (type === "dm" ? `DM: ${id}` : `#${id}`);
      return {
        displayName: friendlyName,
        channelType: "slack",
        channelId: id,
        iconHint: "slack",
      };
    }

    if (channel === "discord") {
      return {
        displayName: channelId || "Discord",
        channelType: "discord",
        iconHint: "hash",
      };
    }

    if (channel === "telegram") {
      return {
        displayName: channelId || "Telegram",
        channelType: "telegram",
        iconHint: "chat",
      };
    }

    return {
      displayName: channelId || channel,
      channelType: channel,
      iconHint: iconForChannelType(channel),
    };
  }

  // Fallback
  return {
    displayName: key,
    channelType: "unknown",
    iconHint: "chat",
  };
}

function detectChannelType(key: string): string {
  if (key.includes("slack")) return "slack";
  if (key.includes("webchat")) return "webchat";
  if (key.includes("discord")) return "discord";
  if (key.includes("telegram")) return "telegram";
  if (key.includes("whatsapp")) return "whatsapp";
  return "unknown";
}

function iconForChannelType(type: string): string {
  switch (type) {
    case "slack":
      return "slack";
    case "webchat":
      return "chat";
    case "discord":
      return "hash";
    case "telegram":
      return "chat";
    case "whatsapp":
      return "chat";
    default:
      return "chat";
  }
}
