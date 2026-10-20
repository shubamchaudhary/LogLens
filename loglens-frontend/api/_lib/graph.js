// DeepLogLens AI as a LangGraph decision graph.
//
//   load_memory ─► understand ─┬─ chat ─────────────────────────────────────┐
//                               ├─ general ──────────────────────────────────┤
//                               ├─ web ──(search fails)──► general ──────────┤
//                               ├─ system ──(not in profile)──► nearest ─────┤
//                               └─ retrieve ─► grade ─(weak)─► rewrite ─┐     │
//                                    ▲                    (ok)│        │     │
//                                    └────────────────────────┼────────┘     │
//                                                     generate ─► verify     │
//                                    (no supported point) ─► system ─► ...   │
//                                                                 save_memory ◄┘ ─► END
//
// Memory: every turn (what was asked, how it was understood, what was answered) goes to
// Redis (memory.js), so follow-ups resolve against what was actually said. Each node
// reports a plain-words step through config.configurable.onStep while it runs.

import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { chatJson, embed, CHAT_MODEL } from './llm.js';
import { getTurns, addTurn, memoryBackend } from './memory.js';
import {
  buildContext, chat, day, general, incidents, logsSystem, nearest, retrieveOnce, system, terms, timeWindows, understand, web,
  history,
} from './answer.js';

const State = Annotation.Root({
  question: Annotation(),
  conversationId: Annotation(),
  turns: Annotation({ reducer: (_, b) => b, default: () => [] }),
  followup: Annotation({ reducer: (_, b) => b, default: () => false }),
  standalone: Annotation(),
  route: Annotation(),
  language: Annotation(),
  // grounded path
  ts: Annotation(),
  windows: Annotation(),
  qv: Annotation(),
  retrieval: Annotation(),
  rewrites: Annotation({ reducer: (_, b) => b, default: () => 0 }),
  // the answer being built, and how we got there
  out: Annotation(),
  trace: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }),
  tokens: Annotation({ reducer: (a, b) => a + (b || 0), default: () => 0 }),
});

const step = (config, label) => config?.configurable?.onStep?.(label);

// ---- nodes --------------------------------------------------------------------------

async function loadMemory(state) {
  const turns = await getTurns(state.conversationId, 4);
  return { turns, trace: turns.length ? [`memory · ${turns.length} earlier turn${turns.length === 1 ? '' : 's'} (${memoryBackend()})`] : [] };
}

async function understandNode(state, config) {
  step(config, 'Understanding your question');
  const [u] = await Promise.all([understand(state.question, state.turns), incidents()]);
  // Only an earlier question can be followed up; greetings and small talk can't.
  if (!state.turns.some((t) => t.mode && t.mode !== 'assistant')) Object.assign(u, { followup: false, standalone: state.question });
  const trace = [`understand → ${u.route}${u.followup ? ' · follow-up' : ''}${u.language !== 'English' ? ` · ${u.language}` : ''}`];
  if (u.followup && u.standalone !== state.question) trace.push(`rewritten as: “${u.standalone}”`);
  return { ...u, trace };
}

const answerWith = (fn, label) =>
  async function node(state, config) {
    step(config, label);
    const out = await fn(state.standalone, state.turns, state.language);
    return { out, tokens: out.usage?.total_tokens };
  };

async function webNode(state, config) {
  step(config, 'Searching the web');
  try {
    const out = await web(state.standalone, state.turns, state.language);
    return { out, tokens: out.usage?.total_tokens, trace: [`web search · ${out.sources?.length || 0} source${out.sources?.length === 1 ? '' : 's'}`] };
  } catch (e) {
    return { out: null, trace: [`web search unavailable (${e.status || 'error'})`] };
  }
}

async function systemNode(state, config) {
  step(config, 'Reading the log profile');
  const out = await system(state.standalone, state.turns, state.language);
  const cited = out.points.reduce((n, p) => n + p.lines.length, 0);
  return { out, tokens: out.usage?.total_tokens, trace: [`log profile · ${out.abstained ? 'does not cover it' : `${cited} example line${cited === 1 ? '' : 's'} cited`}`] };
}

async function nearestNode(state, config) {
  step(config, 'Finding the closest facts the log does have');
  const out = await nearest(state.standalone, state.turns, state.language);
  return { out, tokens: out.usage?.total_tokens, trace: ['not in the log → closest facts from the profile'] };
}

async function retrieveNode(state, config) {
  step(config, state.rewrites ? 'Searching again with better terms' : 'Searching 127k error and warning records');
  let { ts, windows, qv } = state;
  const trace = [];
  if (!ts) {
    ts = terms(state.standalone);
    windows = timeWindows(state.standalone, day);
    try {
      [qv] = await embed([state.standalone], 'RETRIEVAL_QUERY');
    } catch (e) {
      trace.push(`embed failed (${e.status || 'error'}), lexical search only`);
    }
  }
  const r = await retrieveOnce(state.standalone, qv, ts, windows);
  trace.push(`retrieve · ${r.sigs.length} failure types (vector + full-text, RRF) · ${r.events.length} log lines${windows.length ? ` · time filter ${windows.length}` : ''}`);
  return { ts, windows, qv, retrieval: r, trace };
}

async function rewriteNode(state, config) {
  step(config, 'Refining the search');
  try {
    const { json, usage } = await chatJson(
      'Turn a question about application logs into search keywords that would appear in log lines (exception names, service names, HTTP status codes, component names). Return JSON {"keywords": ["..."]} with at most 8 single words, in English.',
      state.standalone,
      { maxTokens: 80 }
    );
    const extra = (json.keywords || []).flatMap((k) => terms(String(k)));
    return {
      ts: [...new Set([...state.ts, ...extra])].slice(0, 16),
      rewrites: state.rewrites + 1,
      tokens: usage?.total_tokens,
      trace: [`rewrite → ${extra.slice(0, 6).join(', ') || 'no new terms'}`],
    };
  } catch (e) {
    return { rewrites: state.rewrites + 1, trace: [`rewrite skipped (${e.status || 'error'})`] };
  }
}

async function generateNode(state, config) {
  step(config, 'Writing an answer with cited lines');
  const r = state.retrieval;
  const ctx = buildContext(r);
  const { json, usage } = await chatJson(logsSystem(state.language), `${history(state.turns)}QUESTION: ${state.standalone}\n\nCONTEXT:\n${ctx.text}`);

  // Verify: keep only citations that exist in the context.
  const byLine = new Map(r.events.map((e) => [e.line_no, e]));
  let dropped = 0;
  const points = (Array.isArray(json.points) ? json.points : [])
    .map((p) => {
      const lines = (p.lines || []).map(Number).filter((n) => ctx.lineSet.has(n));
      const types = (p.types || []).map(String).filter((t) => ctx.refs.has(t));
      dropped += (p.lines || []).length + (p.types || []).length - lines.length - types.length;
      return {
        text: String(p.text || ''),
        lines: lines.map((n) => {
          const e = byLine.get(n);
          return { no: n, end: e.line_end, ts: e.ts, level: e.level, service: e.service, text: e.body };
        }),
        types: types.map((t) => {
          const sg = ctx.refs.get(t);
          return {
            ref: t, level: sg.level, service: sg.service, template: sg.template, sample: sg.sample, count: sg.count,
            firstTs: sg.first_ts, lastTs: sg.last_ts, firstLine: sg.first_line, lastLine: sg.last_line,
          };
        }),
      };
    })
    .filter((p) => p.text && (p.lines.length || p.types.length));

  const text = String(json.answer || '').trim();
  let confidence = ['high', 'medium', 'low'].includes(json.confidence) ? json.confidence : 'low';
  // Numbers in the answer that appear nowhere in the context are a hallucination signal.
  const unsupported = (text.match(/\b\d{2,}(?:,\d{3})*\b/g) || []).filter((n) => !ctx.text.includes(n) && !ctx.text.includes(n.replace(/,/g, '')));
  if (unsupported.length) confidence = 'low';
  const out = {
    mode: 'logs',
    answer: text,
    background: String(json.background || '').trim(),
    abstained: Boolean(json.abstain) || points.length === 0,
    confidence,
    points,
    unsupportedNumbers: unsupported,
  };
  return {
    out,
    tokens: usage?.total_tokens,
    trace: [
      `generate · ${CHAT_MODEL()} · ${points.length} cited point${points.length === 1 ? '' : 's'}` +
        (dropped ? ` · ${dropped} unverifiable citation${dropped === 1 ? '' : 's'} removed` : ''),
    ],
  };
}

async function saveMemory(state) {
  const o = state.out || {};
  await addTurn(state.conversationId, {
    question: state.question,
    standalone: state.standalone,
    route: state.route,
    mode: o.mode,
    answer: String(o.answer || '').slice(0, 600),
    at: new Date().toISOString(),
  }).catch(() => {});
  return {};
}

// ---- edges (the decision tree) -------------------------------------------------------

const byRoute = (s) => ({ chat: 'chat', general: 'general', web: 'web', system: 'system' })[s.route] || 'retrieve';
const afterWeb = (s) => (s.out ? 'save_memory' : 'general');
const afterGrade = (s) => {
  const r = s.retrieval;
  const weak = r.lexicalHits === 0 && r.maxSim < 0.55 && s.windows.length === 0;
  return weak && s.rewrites === 0 ? 'rewrite' : 'generate';
};
// Logs couldn't support an answer: the question may be about the system instead.
const afterGenerate = (s) => (s.out.abstained ? 'system' : 'save_memory');
const afterSystem = (s) => (s.out.abstained ? 'nearest' : 'save_memory');

async function gradeNode(state, config) {
  step(config, 'Checking the evidence');
  const r = state.retrieval;
  return { trace: [`grade → ${r.lexicalHits} lexical hits, best similarity ${r.maxSim.toFixed(2)}`] };
}

const graph = new StateGraph(State)
  .addNode('load_memory', loadMemory)
  .addNode('understand', understandNode)
  .addNode('chat', answerWith(chat, 'Replying'))
  .addNode('general', answerWith(general, 'Answering from general knowledge'))
  .addNode('web', webNode)
  .addNode('system', systemNode)
  .addNode('nearest', nearestNode)
  .addNode('retrieve', retrieveNode)
  .addNode('grade', gradeNode)
  .addNode('rewrite', rewriteNode)
  .addNode('generate', generateNode)
  .addNode('save_memory', saveMemory)
  .addEdge(START, 'load_memory')
  .addEdge('load_memory', 'understand')
  .addConditionalEdges('understand', byRoute, ['chat', 'general', 'web', 'system', 'retrieve'])
  .addEdge('chat', 'save_memory')
  .addEdge('general', 'save_memory')
  .addConditionalEdges('web', afterWeb, ['general', 'save_memory'])
  .addConditionalEdges('system', afterSystem, ['nearest', 'save_memory'])
  .addEdge('nearest', 'save_memory')
  .addEdge('retrieve', 'grade')
  .addConditionalEdges('grade', afterGrade, ['rewrite', 'generate'])
  .addEdge('rewrite', 'retrieve')
  .addConditionalEdges('generate', afterGenerate, ['system', 'save_memory'])
  .addEdge('save_memory', END)
  .compile();

// ---- entry point -------------------------------------------------------------------------

/**
 * Runs the graph for one message. `onStep(label)` is called as each step starts, so the
 * client can show what is happening. Returns the response the Ask panel renders.
 */
export async function runAsk(question, conversationId, onStep) {
  const started = Date.now();
  const s = await graph.invoke({ question, conversationId }, { configurable: { onStep }, recursionLimit: 20 });
  const o = s.out || {};
  let text = String(o.answer || '').replace(/\s+•\s*/g, '\n• ').trim();
  if (!text || /^abstain\.?$/i.test(text)) {
    text = "I couldn't find that in this log. Ask me about its failures, services, tenants or dependencies, or anything general about logs and systems.";
  }
  return {
    question,
    standalone: s.followup ? s.standalone : null,
    mode: o.mode,
    answer: text,
    background: o.background || '',
    sources: o.sources || [],
    abstained: Boolean(o.abstained),
    confidence: o.mode === 'logs' || o.mode === 'system' ? o.confidence : null,
    points: o.abstained ? [] : o.points || [],
    unsupportedNumbers: o.unsupportedNumbers || [],
    trace: s.trace,
    model: CHAT_MODEL(),
    tokens: s.tokens || null,
    ms: Date.now() - started,
  };
}
