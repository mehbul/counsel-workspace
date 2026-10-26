const { retrieve } = require('./retrieval');

function configuration(env = process.env) {
  if (env.COUNSEL_RETRIEVAL !== 'hybrid') return { enabled: false };
  const provider = env.COUNSEL_EMBEDDING_PROVIDER || 'ollama';
  const model = env.COUNSEL_EMBEDDING_MODEL;
  const base = env.COUNSEL_EMBEDDING_URL || 'http://127.0.0.1:11434';
  const url = new URL(base);
  if (!['ollama', 'openai-compatible'].includes(provider) || !model ||
      url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]', 'host.docker.internal'].includes(url.hostname))))
    throw Error('Configure an embedding model and HTTPS or local embedding endpoint.');
  return { enabled: true, provider, model,
    url: url.href.replace(/\/$/, '') + (provider === 'ollama' ? '/api/embed' : '/embeddings'),
    key: env.COUNSEL_EMBEDDING_KEY };
}

function chunks(docs, includeSuperseded = false) {
  const out = [];
  for (const d of docs) {
    if (!d?.id || typeof d.text !== 'string' || (!includeSuperseded && d.supersededBy)) continue;
    d.text.split(/\n\s*\n/).forEach((paragraph, index) => {
      for (let start = 0; start < paragraph.length; start += 1400) {
        const end = Math.min(start + 1600, paragraph.length);
        const text = paragraph.slice(start, end);
        if (text.trim()) out.push({ documentId: d.id, name: d.name || 'Untitled source',
          paragraph: index + 1, startOffset: start, endOffset: end, text,
          ...(d.supersededBy ? { isPreviousVersion: true } : {}) });
        if (end === paragraph.length) break;
      }
    });
  }
  return out;
}

async function embeddings(texts, config, options) {
  const response = await (options.fetch || fetch)(config.url, {
    method: 'POST', redirect: 'error',
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000),
    headers: { 'Content-Type': 'application/json', ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}) },
    body: JSON.stringify({ model: config.model, input: texts }),
  });
  if (!response.ok) { await response.body?.cancel(); throw Error('Embedding provider rejected the request.'); }
  let size = 0;
  const parts = [];
  for await (const part of response.body) {
    size += part.length;
    if (size > 8 * 1024 * 1024) throw Error('Embedding response exceeds its size limit.');
    parts.push(part);
  }
  const data = JSON.parse(Buffer.concat(parts).toString('utf8'));
  const vectors = config.provider === 'ollama' ? data.embeddings : data.data?.slice().sort((a,b) => a.index-b.index).map(x => x.embedding);
  if (!Array.isArray(vectors) || vectors.length !== texts.length ||
      vectors.some(v => !Array.isArray(v) || !v.length || v.length > 16384 || v.some(n => !Number.isFinite(n)) || !v.some(n => n !== 0)))
    throw Error('Embedding provider returned invalid vectors.');
  if (vectors.some(v => v.length !== vectors[0].length)) throw Error('Embedding dimensions do not match.');
  return vectors;
}
function cosine(a,b) {
  if (a.length !== b.length) throw Error('Embedding dimensions do not match.');
  let dot=0, aa=0, bb=0;
  for(let i=0;i<a.length;i++) { dot+=a[i]*b[i]; aa+=a[i]*a[i]; bb+=b[i]*b[i]; }
  return dot/Math.sqrt(aa*bb);
}

function coverage(docs, citations, options = {}) {
  return docs.filter(d => options.includeSuperseded || !d.supersededBy).map(d => {
    const paragraphs = d.text.split(/\n\s*\n/);
    let quotedCharacters = 0;
    for (let p=0;p<paragraphs.length;p++) {
      const intervals = citations.filter(c => c.documentId === d.id && c.paragraph === p+1)
        .map(c => [c.startOffset ?? paragraphs[p].indexOf(c.text), c.endOffset ?? (paragraphs[p].indexOf(c.text)+c.text.length)])
        .filter(([s,e]) => s >= 0 && e <= paragraphs[p].length && e > s).sort((a,b)=>a[0]-b[0]);
      let end=0;
      for(const [s,e] of intervals) { quotedCharacters += Math.max(0,e-Math.max(s,end)); end=Math.max(end,e); }
    }
    const totalCharacters = paragraphs.reduce((n,p)=>n+p.length,0);
    return { documentId:d.id, name:d.name, totalParagraphs:paragraphs.length,
      retrievedParagraphs:new Set(citations.filter(c=>c.documentId===d.id).map(c=>c.paragraph)).size,
      totalCharacters, quotedCharacters, complete: totalCharacters>0 && quotedCharacters===totalCharacters };
  });
}

async function search(query, docs, options = {}) {
  const lexical = retrieve(query, docs, options);
  const config = configuration(options.env || process.env);
  if (!config.enabled) return { citations:lexical, method:'lexical', coverage:coverage(docs,lexical,options) };
  const candidates = chunks(docs, options.includeSuperseded);
  // Refuse incomplete semantic indexing; never silently label a prefix as the whole matter.
  if (candidates.length > 512) throw Error('Semantic search supports up to 512 source chunks per request. Select fewer documents.');
  if (!candidates.length) return { citations:[], method:'hybrid', coverage:coverage(docs,[],options) };
  const vectors = [];
  const inputs = [query, ...candidates.map(c=>c.text)];
  for(let i=0;i<inputs.length;i+=32) vectors.push(...await embeddings(inputs.slice(i,i+32),config,options));
  const semantic = candidates.map((c,i)=>({...c,similarity:cosine(vectors[0],vectors[i+1])})).sort((a,b)=>b.similarity-a.similarity);
  const combined = new Map();
  const key = c => `${c.documentId}:${c.paragraph}:${c.startOffset}:${c.endOffset}`;
  lexical.forEach((c,i)=>combined.set(key(c),{...c,score:1/(60+i+1)}));
  semantic.slice(0,40).forEach((c,i)=>{
    if(c.similarity < 0.35) return;
    const k=key(c), old=combined.get(k);
    combined.set(k,{...c, score:(old?.score || 0)+1/(60+i+1)});
  });
  const selected=[], counts=new Map();
  for(const c of [...combined.values()].sort((a,b)=>b.score-a.score)) {
    if ((counts.get(c.documentId)||0)>=(options.maxPerDocument||3)) continue;
    if(selected.some(p=>p.documentId===c.documentId && p.paragraph===c.paragraph && p.startOffset<c.endOffset && c.startOffset<p.endOffset)) continue;
    selected.push(c); counts.set(c.documentId,(counts.get(c.documentId)||0)+1);
    if(selected.length>=Math.max(1,Math.min(20,options.limit||8))) break;
  }
  return { citations:selected, method:'hybrid', embeddingModel:config.model,
    coverage:coverage(docs,selected,options), notice:'Similarity selects candidate evidence; it does not establish that a clause exists or a conclusion is supported.' };
}
module.exports={search,coverage,chunks,configuration};
