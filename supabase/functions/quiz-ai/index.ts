import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// 중간고사 문제 사이트 → Claude API 중계. 키는 서버 비밀값(ANTHROPIC_API_KEY)에만 있음.
const ALLOWED = ["https://tulmosan-jpg.github.io"];
const SUBJ: Record<string, string> = { sj: "실험조리" }; // AI 새 문제는 실험조리만 허용
const MODEL = Deno.env.get("MODEL") ?? "claude-sonnet-5-5";
const IP_LIMIT = Number(Deno.env.get("IP_LIMIT") ?? 20);   // 한 사람(IP) 24시간 호출 수
const DAY_LIMIT = Number(Deno.env.get("DAY_LIMIT") ?? 300); // 전체 24시간 호출 수

const cors = (o: string) => ({
  "Access-Control-Allow-Origin": o,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});
const j = (o: string, s: number, b: unknown) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors(o), "Content-Type": "application/json" } });
const cut = (v: unknown, n: number) => String(v ?? "").slice(0, n);

async function sha(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s + "quiz-salt"));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  const o = ALLOWED.includes(origin) ? origin : ALLOWED[0];
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(o) });
  if (req.method !== "POST") return j(o, 405, { error: "method" });
  if (!ALLOWED.includes(origin)) return j(o, 403, { error: "origin" });

  let body: any;
  try { body = await req.json(); } catch { return j(o, 400, { error: "json" }); }
  const subj = SUBJ[body?.subj];
  if (!subj) return j(o, 400, { error: "subj" });
  const label = cut(body.label, 40), scope = cut(body.scope, 700);
  const ex = (Array.isArray(body.examples) ? body.examples : []).slice(0, 8).map((x: unknown) => "- " + cut(x, 300));

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return j(o, 500, { error: "nokey" });

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: lim, error: le } = await sb.rpc("ai_take", { p_ip: await sha(ip), p_ip_limit: IP_LIMIT, p_day_limit: DAY_LIMIT });
  if (le) return j(o, 500, { error: "limit" });
  if (lim !== "ok") return j(o, 429, { error: lim === "day" ? "day" : "ip" });

  const prompt = `대학 ${subj} 과목의 '${label}' 범위로 5지선다 객관식 문제 5개를 새로 만들어라.
범위 설명: ${scope || label}
${ex.length ? "아래는 이미 있는 문제다. 똑같이 베끼지 말고, 같은 개념을 다른 각도·사례·숫자로 묻는 새 문제를 만들어라.\n" + ex.join("\n") : ""}
조건:
- 교과서적으로 확실한 사실만 사용하고, 정답은 하나만 명확하게.
- 보기 5개. 정답 위치는 골고루.
- 해설은 1~3문장. 계산문제면 해설에 【공식】 【풀이】를 줄바꿈(\\n)으로 넣어라.
- 사례형이면 사례 문장은 c에, 아니면 c는 빈 문자열.
- 한국어. 랜덤 시드 ${Date.now()}
JSON만 출력: {"questions":[{"q":"문제","c":"","o":["보기1","보기2","보기3","보기4","보기5"],"a":정답인덱스0~4,"e":"해설"}]}`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL, max_tokens: 3000,
      system: "너는 한국 영양사 국가시험 출제위원이다. 설명 없이 JSON 객체 하나만 출력한다.",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) return j(o, 502, { error: "api", status: r.status });
  const d = await r.json();
  const text = (d.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  try {
    const p = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const qs = (p.questions ?? []).filter((x: any) => x && x.q && Array.isArray(x.o) && x.o.length >= 2 && Number.isInteger(x.a) && x.a >= 0 && x.a < x.o.length)
      .slice(0, 5).map((x: any) => ({ q: cut(x.q, 600), c: cut(x.c, 600), o: x.o.slice(0, 6).map((v: unknown) => cut(v, 200)), a: x.a, e: cut(x.e, 800) }));
    if (!qs.length) throw 0;
    return j(o, 200, { questions: qs });
  } catch { return j(o, 502, { error: "parse" }); }
});
