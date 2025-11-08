// server.js — completo com rotas administrativas
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { createClient } from '@supabase/supabase-js';
import mime from 'mime-types';
import adminRouter from './admin-routes.js';

/* =========================
   CONFIG & SAFETY CHECKS
========================= */
const REQUIRED_ENVS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_BUCKET'];
const missing = REQUIRED_ENVS.filter((k) => !process.env[k]);
if (missing.length) {
  console.warn('[WARN] Variáveis de ambiente ausentes:', missing.join(', '));
}

const PORT = Number(process.env.PORT || 10000);
const RAW_ORIGINS = process.env.CORS_ORIGIN || '*';
const ALLOWLIST = RAW_ORIGINS.split(',').map((s) => s.trim());
const MAX_FILE_MB = Math.max(1, Number(process.env.MAX_FILE_MB || 5));
const RETENTION_DAYS = Math.max(1, Number(process.env.RETENTION_DAYS || 90));
const BUCKET = process.env.SUPABASE_BUCKET || 'curriculos';
const CLEANUP_TOKEN = process.env.CLEANUP_TOKEN || '';

/* =========================
   APP & MIDDLEWARES
========================= */
const app = express();

// Headers de segurança leves
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// CORS com allowlist
app.use((req, res, next) => {
  res.setHeader('Vary', 'Origin');
  next();
});
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (origin === 'null' && (ALLOWLIST.includes('*') || ALLOWLIST.includes('null'))) {
        return cb(null, true);
      }
      if (ALLOWLIST.includes('*') || ALLOWLIST.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error('Not allowed by CORS'));
    },
  })
);
app.options('*', cors());

// Logs simples
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => console.info(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now()-start}ms)`));
  next();
});

// Healthcheck
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Supabase
const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '', {
  auth: { persistSession: false },
});

// Upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (ok.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Formato inválido. Envie PDF, DOC ou DOCX.'));
  },
});

/* =========================
   UTILS
========================= */
const slugify = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

const toBR = (d) => new Date(d).toLocaleDateString('pt-BR');
const addDays = (d, days) => new Date(new Date(d).getTime() + days * 86400000);
const clean = (s, max = 200) => String(s ?? '').trim().slice(0, max);
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').toLowerCase());

function isCPF(cpfRaw) {
  const cpf = String(cpfRaw || '').replace(/\D/g, '');
  if (!cpf || cpf.length !== 11) return false;
  if (/^(\d)\1+$/.test(cpf)) return false;
  const dv = (base) => {
    let sum = 0;
    for (let i = 0; i < base.length; i++) sum += Number(base[i]) * (base.length + 1 - i);
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  };
  const d1 = dv(cpf.slice(0, 9));
  const d2 = dv(cpf.slice(0, 9) + d1);
  return cpf.endsWith(`${d1}${d2}`);
}

function validatePayload(p) {
  const reqs = ['nome','cpf','telefone','email','cep','cidade','bairro','rua','transporte','vaga'];
  const miss = reqs.filter((k) => !p[k]);
  if (miss.length) return { ok: false, message: `Campos obrigatórios faltando: ${miss.join(', ')}` };
  if (!isEmail(p.email)) return { ok: false, message: 'E-mail inválido.' };
  if (!isCPF(p.cpf)) return { ok: false, message: 'CPF inválido.' };
  if (p.nome.length > 180 || p.email.length > 180 || p.cidade.length > 120 || p.bairro.length > 120 || p.rua.length > 180 || p.vaga.length > 180)
    return { ok: false, message: 'Alguns campos excedem o tamanho permitido.' };
  return { ok: true };
}

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* =========================
   RATE LIMIT leve
========================= */
const buckets = new Map();
const WINDOW_MS = 60_000;
const MAX_REQ = 30;
function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.ip || 'local';
  const now = Date.now();
  const b = buckets.get(ip) || { ts: now, count: 0 };
  if (now - b.ts > WINDOW_MS) { b.ts = now; b.count = 0; }
  b.count++; buckets.set(ip, b);
  if (b.count > MAX_REQ) return res.status(429).json({ message: 'Muitas requisições. Tente novamente em instantes.' });
  next();
}

/* =========================
   GET /api/vagas
========================= */
app.get('/api/vagas', asyncRoute(async (req, res) => {
  const { data, error } = await supabase
    .from('vagas')
    .select('id, nome, ativa')
    .eq('ativa', true)
    .order('nome', { ascending: true });

  if (error) {
    console.error('[VAGAS] Erro ao buscar:', error);
    return res.status(500).json({ message: 'Erro ao buscar vagas disponíveis.' });
  }

  res.json(data || []);
}));

/* =========================
   POST /api/enviar
========================= */
app.post('/api/enviar', rateLimit, upload.single('arquivo'), asyncRoute(async (req, res) => {
  const body = {
    nome: clean(req.body?.nome),
    cpf: clean(req.body?.cpf),
    telefone: clean(req.body?.telefone, 40),
    email: clean(req.body?.email),
    cep: clean(req.body?.cep, 12),
    cidade: clean(req.body?.cidade),
    bairro: clean(req.body?.bairro),
    rua: clean(req.body?.rua),
    transporte: clean(req.body?.transporte, 40),
    vaga: clean(req.body?.vaga),
    data: clean(req.body?.data || new Date().toISOString(), 40),
  };
  const valid = validatePayload(body);
  if (!valid.ok) return res.status(400).json({ message: valid.message });
  if (!req.file) return res.status(400).json({ message: 'Arquivo é obrigatório.' });

  const cpfNorm = body.cpf.replace(/\D/g, '').slice(0, 11);
  const vagaNorm = body.vaga.toLowerCase().trim();

  // Duplicidade antes do upload
  const { data: existed, error: exErr } = await supabase
    .from('candidaturas')
    .select('id, enviado_em, vaga')
    .eq('cpf_norm', cpfNorm)
    .eq('vaga_norm', vagaNorm)
    .order('enviado_em', { ascending: false })
    .limit(1);
  if (exErr) return res.status(500).json({ message: 'Falha ao verificar duplicidade.' });

  if (existed?.length) {
    const enviado = new Date(existed[0].enviado_em);
    const diffDays = Math.floor((Date.now() - enviado.getTime()) / 86400000);
    const daysLeft = Math.max(0, RETENTION_DAYS - diffDays);
    const reapplyDate = addDays(enviado, RETENTION_DAYS);
    return res.status(409).json({
      ok: false,
      reason: 'duplicate',
      message:
        `Identificamos que já existe uma candidatura registrada para a vaga "${existed[0].vaga}" com o mesmo CPF, enviada em ${toBR(enviado)}. ` +
        `Conforme nossa política, é necessário aguardar ${daysLeft} dia(s), até ${toBR(reapplyDate)}, para realizar um novo envio.`,
      enviado_em: enviado.toISOString(),
      pode_reenviar_em: reapplyDate.toISOString(),
    });
  }

  // Upload
  const ext = mime.extension(req.file.mimetype) || 'bin';
  const safeNome = slugify(body.nome);
  const safeVaga = slugify(body.vaga);
  const fileId = `${safeVaga}/${cpfNorm || nanoid(6)}-${safeNome}-${Date.now()}-${nanoid(6)}.${ext}`;

  const { error: upErr } = await supabase.storage.from(BUCKET)
    .upload(fileId, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
  if (upErr) return res.status(500).json({ message: 'Falha ao salvar arquivo no Storage.' });

  const { data: signedData } = await supabase.storage.from(BUCKET).createSignedUrl(fileId, 60*60*24*30);

  const payloadDB = {
    nome: body.nome, cpf: body.cpf, telefone: body.telefone, email: body.email,
    cep: body.cep, cidade: body.cidade, bairro: body.bairro, rua: body.rua,
    transporte: body.transporte, vaga: body.vaga,
    arquivo_path: fileId, arquivo_url: signedData?.signedUrl || null,
    enviado_em: new Date(body.data).toISOString(),
  };

  const { error: dbErr } = await supabase.from('candidaturas').insert(payloadDB);
  if (dbErr) {
    await supabase.storage.from(BUCKET).remove([fileId]).catch(() => {});
    if (dbErr.code === '23505') {
      return res.status(409).json({
        ok: false,
        reason: 'duplicate',
        message:
          `Identificamos que já existe uma candidatura registrada para a vaga "${body.vaga}" com o mesmo CPF. ` +
          `Aguarde o período de ${RETENTION_DAYS} dia(s) antes de reenviar.`,
      });
    }
    return res.status(500).json({ message: 'Falha ao gravar dados no banco.' });
  }

  return res.json({
    ok: true,
    message: 'Sua candidatura foi enviada com sucesso. Agradecemos seu interesse e entraremos em contato caso seu perfil seja selecionado.',
  });
}));

/* =========================
   POST /internal/cleanup
========================= */
app.post('/internal/cleanup', asyncRoute(async (req, res) => {
  if (!CLEANUP_TOKEN || req.header('X-CRON-TOKEN') !== CLEANUP_TOKEN) {
    return res.status(401).json({ ok: false, message: 'unauthorized' });
  }
  const windowDays = Math.max(1, Number(process.env.RETENTION_DAYS || RETENTION_DAYS));
  const cutoff = new Date(Date.now() - windowDays*86400000).toISOString();
  let removed = 0;

  for (let i=0; i<50; i++) {
    const { data: rows, error: selErr } = await supabase
      .from('candidaturas').select('id, arquivo_path').lt('enviado_em', cutoff).limit(200);
    if (selErr) return res.status(500).json({ ok:false, message:'Falha ao listar registros para limpeza.' });
    if (!rows?.length) break;

    const paths = rows.map(r => r.arquivo_path).filter(Boolean);
    if (paths.length) {
      const { error: remErr } = await supabase.storage.from(BUCKET).remove(paths);
      if (remErr) console.warn('[cleanup/storage] aviso:', remErr.message);
    }

    const ids = rows.map(r => r.id);
    const { error: delErr } = await supabase.from('candidaturas').delete().in('id', ids);
    if (delErr) return res.status(500).json({ ok:false, message:'Falha ao excluir registros do banco.' });

    removed += rows.length;
  }

  res.json({ ok:true, removed, cutoff });
}));

/* =========================
   ROTAS ADMINISTRATIVAS
========================= */
app.use('/api/admin', adminRouter);

/* =========================
   404 & ERROR HANDLERS
========================= */
app.use((req, res) => res.status(404).json({ message: 'Rota não encontrada.' }));

app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ message: 'Origem não autorizada por CORS.' });
  }
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ message: `Arquivo muito grande. Tamanho máximo: ${MAX_FILE_MB} MB.` });
    }
    return res.status(400).json({ message: 'Erro ao processar upload.' });
  }
  console.error('[ERROR]', err?.message || err);
  return res.status(500).json({ message: 'Erro interno.' });
});

/* =========================
   START
========================= */
app.listen(PORT, () => {
  console.log(`API porta ${PORT} | Retention ${RETENTION_DAYS}d | Bucket ${BUCKET} | CORS_ORIGIN: ${RAW_ORIGINS}`);
  console.log(`Sistema administrativo disponível em: http://localhost:${PORT}/admin.html`);
});
