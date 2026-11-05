/**
 * SAP AI Core orchestration wrapper (adapted from Sales_Intelligence/backend/ai-core.js).
 * Locally the SDK reads AICORE_SERVICE_KEY; on Cloud Foundry it reads the bound `aicore` service.
 */
let orchestration = null;

function hasVcapAicoreBinding() {
  try {
    return Boolean(JSON.parse(process.env.VCAP_SERVICES || '{}').aicore);
  } catch {
    return false;
  }
}

export function isAiConfigured(aiConfig) {
  return aiConfig.enabled && (Boolean(aiConfig.serviceKey) || hasVcapAicoreBinding());
}

/**
 * Chat completion with a tool-calling loop.
 * @param {object} options
 * @param {Array<{role: string, content: string}>} options.messages system + history + user
 * @param {Array} options.tools OpenAI-style function definitions
 * @param {(name: string, args: object) => Promise<object>} options.executeToolCall
 */
export async function chatWithTools({ model, messages, tools, executeToolCall, maxRounds = 4 }) {
  orchestration ||= await import('@sap-ai-sdk/orchestration');
  const client = new orchestration.OrchestrationClient({
    promptTemplating: {
      model: { name: model, params: { temperature: 0.1 } },
      prompt: { tools },
    },
  });

  let response = await client.chatCompletion({ messages });
  for (let round = 0; round < maxRounds; round++) {
    const toolCalls = response.getToolCalls();
    if (!toolCalls || toolCalls.length === 0) break;
    const toolMessages = [];
    for (const call of toolCalls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        args = {};
      }
      const result = await executeToolCall(call.function.name, args);
      toolMessages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
    response = await client.chatCompletion({ messages: toolMessages, messagesHistory: response.getAllMessages() });
  }
  return (response.getContent() || '').trim();
}
