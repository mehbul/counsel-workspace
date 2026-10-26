function modelConfiguration(env = process.env) {
  const provider = env.AI_PROVIDER || "evidence";
  if (provider === "evidence")
    return { enabled: false, provider, label: "Local evidence mode" };
  if (provider === "openai")
    return {
      enabled: !!env.OPENAI_API_KEY,
      provider,
      label: "OpenAI API configured",
      model: env.OPENAI_MODEL || "gpt-4.1-mini",
      url: "https://api.openai.com/v1/responses",
      key: env.OPENAI_API_KEY,
      error: env.OPENAI_API_KEY
        ? null
        : "Set OPENAI_API_KEY or select evidence mode.",
    };
  if (provider === "anthropic")
    return profileConfiguration({
      provider,
      model: env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      apiKey: env.ANTHROPIC_API_KEY,
      contextTokens: Number(env.AI_CONTEXT_TOKENS) || 32000,
      maxOutputTokens: Number(env.AI_MAX_OUTPUT_TOKENS) || 4000,
    });
  if (!["ollama", "openai-compatible"].includes(provider))
    return {
      enabled: false,
      provider,
      label: "Model configuration needs attention",
      error:
        "AI_PROVIDER must be evidence, ollama, openai or openai-compatible.",
    };
  const model =
    provider === "ollama" ? env.OLLAMA_MODEL || env.AI_MODEL : env.AI_MODEL;
  const base =
    provider === "ollama"
      ? env.OLLAMA_BASE_URL || "http://127.0.0.1:11434"
      : env.AI_BASE_URL;
  try {
    if (!base || !model) throw Error("missing");
    const url = new URL(base);
    if (url.username || url.password || url.search || url.hash)
      throw Error("invalid");
    const local = [
      "localhost",
      "127.0.0.1",
      "[::1]",
      "host.docker.internal",
    ].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
      throw Error("insecure");
    return {
      enabled: true,
      provider,
      label:
        provider === "ollama"
          ? "Local model configured"
          : "Compatible model endpoint configured",
      model,
      url:
        url.href.replace(/\/$/, "") +
        (provider === "ollama" ? "/api/chat" : "/chat/completions"),
      key: provider === "openai-compatible" ? env.AI_API_KEY : undefined,
    };
  } catch {
    return {
      enabled: false,
      provider,
      label: "Model configuration needs attention",
      error:
        "Set the model name and an HTTPS endpoint (or HTTP on loopback/host.docker.internal). Use OLLAMA_MODEL and OLLAMA_BASE_URL, or AI_MODEL and AI_BASE_URL.",
    };
  }
}
function profileConfiguration(profile) {
  const common = {
    provider: profile.provider,
    model: profile.model,
    contextTokens: profile.contextTokens || 32000,
    maxOutputTokens: profile.maxOutputTokens || 4000,
  };
  if (profile.provider === "evidence")
    return { ...common, enabled: false, label: "Local evidence mode" };
  if (["openai", "anthropic"].includes(profile.provider))
    return {
      ...common,
      enabled: !!profile.apiKey,
      key: profile.apiKey,
      url:
        profile.provider === "openai"
          ? "https://api.openai.com/v1/responses"
          : "https://api.anthropic.com/v1/messages",
      label: profile.provider + " API configured",
      error: profile.apiKey ? null : "Enter an API key explicitly.",
    };
  const result = modelConfiguration({
    AI_PROVIDER: profile.provider,
    AI_MODEL: profile.model,
    OLLAMA_MODEL: profile.model,
    AI_BASE_URL: profile.baseUrl,
    OLLAMA_BASE_URL: profile.baseUrl || "http://127.0.0.1:11434",
    AI_API_KEY: profile.apiKey,
  });
  return { ...result, ...common };
}
async function generate(messages, options = {}) {
  const config =
    options.config || modelConfiguration(options.env || process.env);
  if (!config.enabled) throw Error(config.error || "No model configured.");
  const maxOutputTokens = Math.min(
    options.maxOutputTokens || config.maxOutputTokens || 4000,
    config.maxOutputTokens || 4000,
  );
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1)
    throw Error("Invalid output token budget.");
  // UTF-8 bytes upper-bound input tokens conservatively; no silent source truncation.
  const inputEstimate = messages.reduce(
    (total, message) =>
      total + Buffer.byteLength(JSON.stringify(message), "utf8") + 16,
    0,
  );
  if (inputEstimate + maxOutputTokens > (config.contextTokens || 32000))
    throw Error(
      "Input exceeds the configured context budget. Reduce selected source text or increase the context budget.",
    );
  options.signal?.throwIfAborted();
  const started = Date.now();
  const body =
    config.provider === "openai"
      ? {
          model: config.model,
          store: false,
          max_output_tokens: maxOutputTokens,
          input: messages,
        }
      : config.provider === "anthropic"
        ? {
            model: config.model,
            max_tokens: maxOutputTokens,
            system: messages
              .filter((m) => m.role === "system")
              .map((m) => m.content)
              .join("\n\n"),
            messages: messages
              .filter((m) => m.role !== "system")
              .map((m) => ({
                role: m.role === "assistant" ? "assistant" : "user",
                content: m.content,
              })),
          }
        : config.provider === "ollama"
          ? {
              model: config.model,
              messages,
              stream: false,
              options: {
                num_predict: maxOutputTokens,
                num_ctx: config.contextTokens || 32000,
              },
            }
          : {
              model: config.model,
              messages,
              stream: false,
              max_tokens: maxOutputTokens,
            };
  let response;
  try {
    response = await (options.fetch || fetch)(config.url, {
      method: "POST",
      redirect: "manual",
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(90000)])
        : AbortSignal.timeout(90000),
      headers: {
        "Content-Type": "application/json",
        ...(config.provider === "anthropic"
          ? { "x-api-key": config.key, "anthropic-version": "2023-06-01" }
          : config.key
            ? { Authorization: "Bearer " + config.key }
            : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    options.signal?.throwIfAborted();
    throw Error(
      "Cannot reach the configured model endpoint. Check that the local server is running or that provider access is configured.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(
      config.provider === "ollama"
        ? "Local model request failed. Check that the selected model is installed and the Ollama endpoint is reachable."
        : "Model provider rejected the request. Check credentials, model access and quota.",
    );
  }
  let total = 0;
  const chunks = [];
  for await (const part of response.body) {
    total += part.length;
    if (total > 2 * 1024 * 1024)
      throw Error("Model response exceeds the size limit.");
    chunks.push(part);
  }
  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Error("Model endpoint returned invalid JSON.");
  }
  const content =
    config.provider === "openai"
      ? data.output
          ?.flatMap((o) => o.content || [])
          .filter((c) => c.type === "output_text")
          .map((c) => c.text)
          .join("\n")
      : config.provider === "anthropic"
        ? data.content
            ?.filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n")
        : config.provider === "ollama"
          ? data.message?.content
          : data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim())
    throw Error("Model returned no text.");
  return {
    text: content,
    mode: config.provider === "ollama" ? "Local model analysis" : "AI analysis",
    provider: config.provider,
    model: config.model,
    elapsedMs: Date.now() - started,
    usage: {
      inputTokens: numericUsage(
        config.provider === "ollama"
          ? data.prompt_eval_count
          : (data.usage?.input_tokens ?? data.usage?.prompt_tokens),
      ),
      outputTokens: numericUsage(
        config.provider === "ollama"
          ? data.eval_count
          : (data.usage?.output_tokens ?? data.usage?.completion_tokens),
      ),
      inputBudgetEstimate: inputEstimate,
      contextTokens: config.contextTokens || 32000,
      maxOutputTokens,
    },
  };
}
function numericUsage(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
module.exports = { modelConfiguration, profileConfiguration, generate };
