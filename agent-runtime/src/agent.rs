use serde::{Deserialize, Serialize};

pub const MAX_MESSAGES: usize = 50;
pub const MAX_MESSAGE_CHARS: usize = 20_000;
pub const MAX_DOCUMENT_CHARS: usize = 200_000;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DocumentSnapshot {
    pub text: String,
}

#[derive(Debug, Deserialize)]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
    pub document: DocumentSnapshot,
}

#[derive(Debug, Serialize, PartialEq, Clone)]
pub struct ToolCall {
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct ChatResponse {
    pub reply: String,
    #[serde(rename = "toolCalls")]
    pub tool_calls: Vec<ToolCall>,
    pub model: String,
}

pub fn validate(req: &ChatRequest) -> Result<(), String> {
    if req.messages.is_empty() {
        return Err("messages must not be empty".into());
    }
    if req.messages.len() > MAX_MESSAGES {
        return Err(format!("too many messages (max {MAX_MESSAGES})"));
    }
    for (i, m) in req.messages.iter().enumerate() {
        if m.role != "user" && m.role != "assistant" {
            return Err(format!("messages[{i}].role must be 'user' or 'assistant'"));
        }
        if m.content.trim().is_empty() {
            return Err(format!("messages[{i}].content must not be empty"));
        }
        if m.content.chars().count() > MAX_MESSAGE_CHARS {
            return Err(format!(
                "messages[{i}].content exceeds {MAX_MESSAGE_CHARS} characters"
            ));
        }
    }
    if req.messages[0].role != "user" {
        return Err("first message must have role 'user'".into());
    }
    if req.messages.last().map(|m| m.role.as_str()) != Some("user") {
        return Err("last message must have role 'user'".into());
    }
    if req.document.text.chars().count() > MAX_DOCUMENT_CHARS {
        return Err(format!(
            "document.text exceeds {MAX_DOCUMENT_CHARS} characters"
        ));
    }
    Ok(())
}

/// Flattens the conversation into a single prompt for `claude -p` (sent via stdin).
pub fn build_prompt(messages: &[ChatMessage]) -> String {
    if messages.len() == 1 {
        return messages[0].content.clone();
    }
    let mut out = String::from("Conversation so far:\n\n");
    for m in messages {
        out.push_str(&format!("[{}]\n{}\n\n", m.role, m.content));
    }
    out.push_str("Reply to the last [user] message.");
    out
}
