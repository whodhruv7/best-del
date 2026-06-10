function stripLeadingDoubleS(v: string | undefined): string | undefined {
  if (!v) return v;
  if (v.startsWith("ssk-")) return v.slice(1);
  return v;
}

const PLACEHOLDER_VALUE_RE = /^(your|insert|replace|todo|changeme|example|dummy|none|null|undefined)(?:[_-]|$)/i;

function cleanEnvValue(v: string | undefined): string | undefined {
  const trimmed = stripLeadingDoubleS(v?.trim());
  if (!trimmed) return undefined;
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return undefined;
  if (PLACEHOLDER_VALUE_RE.test(trimmed)) return undefined;
  return trimmed;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function splitEnvValues(value: string | undefined): string[] {
  return value
    ?.split(",")
    .map((part) => cleanEnvValue(part))
    .filter((part): part is string => Boolean(part)) ?? [];
}

function pickNumberedEnv(baseNames: string[]): string[] {
  const numbered: string[] = [];
  for (const baseName of baseNames) {
    for (let i = 1; i <= 5; i += 1) {
      numbered.push(...splitEnvValues(process.env[`${baseName}_${i}`]));
    }
  }

  if (numbered.length) return unique(numbered);

  const direct: string[] = [];
  for (const baseName of baseNames) {
    direct.push(...splitEnvValues(process.env[baseName]));
  }

  return unique(direct);
}

function promoteEnv(baseName: string, aliases: string[] = []): void {
  const values = pickNumberedEnv([baseName, ...aliases]);
  if (values.length) process.env[baseName] = values.join(",");
  else delete process.env[baseName];
}

function promoteEnvPair(primary: string, alias: string): void {
  promoteEnv(primary, [alias]);
  promoteEnv(alias, [primary]);
}

export function normalizeApiKeys(): void {
  [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "GROQ_API_KEY",
    "NVIDIA_API_KEY",
    "GEMINI_API_KEY",
    "CEREBRAS_API_KEY",
    "OLLAMA_API_KEY",
    "TAVILY_API_KEY",
    "EXA_API_KEY",
    "FIRECRAWL_API_KEY",
    "SCRAPERAPI_KEY",
    "ZENROWS_API_KEY",
    "SCRAPINGBEE_API_KEY",
    "GEEKFLARE_API_KEY",
    "HF_TOKEN",
  ].forEach((name) => promoteEnv(name));

  promoteEnvPair("OPENROUTER_API_KEY", "OPENROUTER_KEY");
  promoteEnvPair("GITHUB_MODELS_API_KEY", "GITHUB_TOKEN");
  promoteEnvPair("SERPER_API_KEY", "SERPER_KEY");
  promoteEnvPair("BRAVE_API_KEY", "BRAVE_KEY");
  promoteEnvPair("JINA_API_KEY", "JINA_KEY");

  let a = cleanEnvValue(process.env.ANTHROPIC_API_KEY);
  const openAiValues = splitEnvValues(process.env.OPENAI_API_KEY);
  const deepSeekValues = splitEnvValues(process.env.DEEPSEEK_API_KEY);

  const looksLikeOpenAI = (v?: string) => !!v && (v.startsWith("sk-svcacct") || v.startsWith("sk-proj-") || (v.startsWith("sk-") && v.length > 80));
  const looksLikeAnthropic = (v?: string) => !!v && v.startsWith("sk-ant-");
  const looksLikeDeepSeek = (v?: string) => !!v && /^sk-[a-f0-9]{20,40}$/i.test(v);

  const o = unique([...openAiValues, ...deepSeekValues.filter(looksLikeOpenAI)]).filter(looksLikeOpenAI);
  const d = unique([...deepSeekValues, ...openAiValues.filter(looksLikeDeepSeek)]).filter(looksLikeDeepSeek);

  if (a && !looksLikeAnthropic(a)) {
    a = undefined;
  }

  if (a) process.env.ANTHROPIC_API_KEY = a;
  else delete process.env.ANTHROPIC_API_KEY;
  if (o.length) process.env.OPENAI_API_KEY = o.join(",");
  else delete process.env.OPENAI_API_KEY;
  if (d.length) process.env.DEEPSEEK_API_KEY = d.join(",");
  else delete process.env.DEEPSEEK_API_KEY;
}
