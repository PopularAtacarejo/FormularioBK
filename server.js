// server.js — completo e atualizado (Express + Supabase)
// Recursos: CORS com allowlist, validação forte (CPF/e-mail), duplicidade (409) com mensagem formal,
// rollback de arquivo em erro, headers de segurança, rate limit leve, healthcheck e cleanup 90d.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { createClient } from '@supabase/supabase-js';
import mime from 'mime-types';

/* =========================
   CONFIG & SAFETY CHECKS
========================= */
const REQUIRED_ENVS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_BUCKET'];
const missing = REQUIRED_ENVS.filter((k) => !process.env[k]);
if (missing.length) {
  console.warn('[WARN] Variáveis de ambiente ausentes:', missing.join(', '));
}

const PORT = Number(process.env.PORT || 10000);
const RAW_ORIGINS = process.env.CORS_ORIGIN || '*'; // ex.: "http://localhost:5500,https://seu-front.com"
const ALLOWLIST = RAW_ORIGINS.split(',').map((s) => s.trim());
const MAX_FILE_MB = Math.max(1, Number(process.env.MAX_FILE_MB || 5));
const RETENTION_DAYS = Math.max(1, Number(process.env.RETENTION_DAYS || 90)); // janela de bloqueio e limpeza
const BUCKET = process.env.SUPABASE_BUCKET || 'curriculos';
const CLEANUP_TOKEN = process.env.CLEANUP_TOKEN || '';

/* =========================
   APP & MIDDLEWARES
========================= */
const app = express();

// Cabeçalhos de segurança básicos
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// CORS robusto (allowlist + suporte a origin ausente e origin:null em testes)
app.use((req, res, next) => {
  res.setHeader('Vary', 'Origin'); // torna cache-aware por origem
  next();
});
app.use(
  cors({
    origin: (origin, cb) => {
      // Sem origin (curl/Postman) -> permite
      if (!origin) return cb(null, true);
      // Em testes locais, abrir arquivo direto gera origin "null"
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
// Preflight global
app.options('*', cors());

// Logs simples
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.info(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// Healthcheck (para o front checar disponibilidade)
app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Supabase (usar SERVICE_ROLE somente no backend)
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  { auth: { persistSession: false } }
);

// Upload em memória + validações de tipo/tamanho
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
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

// Sanitização simples: tira espaços extremos e limita tamanho
const clean = (s, max = 200) => String(s ?? '').trim().slice(0, max);

// E-mail básico
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').toLowerCase());

// CPF com dígitos verificadores
function isCPF(cpfRaw) {
  const cpf = String(cpfRaw || '').replace(/\D/g, '');
  if (!cpf || cpf.length !== 11) return false;
  if (/^(\d)\1+$/.test(cpf)) return false; // todos iguais
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

// Validação de payload
function validatePayload(p) {
  const errors = [];

  if (!p.nome) errors.push('nome');
  if (!p.cpf) errors.push('cpf');
  if (!p.telefone) errors.push('telefone');
  if (!p.email) errors.push('email');
  if (!p.cep) errors.push('cep');
  if (!p.cidade) errors.push('cidade');
  if (!p.bairro) errors.push('bairro');
  if (!p.rua) errors.push('rua');
  if (!p.transporte) errors.push('transporte');
  if (!p.vaga) errors.push('vaga');

  if (errors.length) {
    return { ok: false, message: `Campos obrigatórios faltando: ${errors.join(', ')}` };
  }
  if (!isEmail(p.email)) {
    return { ok: false, message: 'E-mail inválido.' };
  }
  if (!isCPF(p.cpf)) {
    return { ok: false, message: 'CPF inválido.' };
  }
  // Tamanhos máximos para evitar abuso
  const tooLong =
    p.nome.length > 180 ||
    p.email.length > 180 ||
    p.cidade.length > 120 ||
    p.bairro.length > 120 ||
    p.rua.length > 180 ||
    p.vaga.length > 180;
  if (tooLong) {
    return { ok: false, message: 'Alguns campos excedem o tamanho permitido.' };
  }
  return { ok: true };
}

// Wrapper de rota assíncrona (propaga para error middleware)
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* =========================
   RATE LIMIT (memória)
========================= */
const buckets = new Map(); // ip -> { ts, count }
const WINDOW_MS = 60_000; // 1 min
const MAX_REQ = 30; // por IP por janela
function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.ip || 'local';
  const now = Date.now();
  const b = buckets.get(ip) || { ts: now, count: 0 };
  if (now - b.ts > WINDOW_MS) {
    b.ts = now;
    b.count = 0;
  }
  b.count++;
  buckets.set(ip, b);
  if (b.count > MAX_REQ) {
    return res.status(429).json({ message: 'Muitas requisições. Tente novamente em instantes.' });
  }
  next();
}

/* =========================
   /api/enviar
========================= */
app.post(
  '/api/enviar',
  rateLimit,
  upload.single('arquivo'),
  asyncRoute(async (req, res) => {
    // 1) Normaliza & valida
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
    if (!valid.ok) {
      return res.status(400).json({ message: valid.message });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'Arquivo é obrigatório.' });
    }

    const cpfNorm = body.cpf.replace(/\D/g, '').slice(0, 11);
    const vagaNorm = body.vaga.toLowerCase().trim();

    // 2) Checagem de duplicidade ANTES do upload
    const { data: existedRows, error: exErr } = await supabase
      .from('candidaturas')
      .select('id, enviado_em, vaga')
      .eq('cpf_norm', cpfNorm)
      .eq('vaga_norm', vagaNorm)
      .order('enviado_em', { ascending: false })
      .limit(1);

    if (exErr) {
      console.error('[dup-check] erro:', exErr);
      return res.status(500).json({ message: 'Falha ao verificar duplicidade.' });
    }

    if (existedRows?.length) {
      const enviado = new Date(existedRows[0].enviado_em);
      const hoje = new Date();
      const diffDays = Math.floor((hoje.getTime() - enviado.getTime()) / 86400000);
      const daysLeft = Math.max(0, RETENTION_DAYS - diffDays);
      const reapplyDate = addDays(enviado, RETENTION_DAYS);

      return res.status(409).json({
        ok: false,
        reason: 'duplicate',
        message:
          `Identificamos que já existe uma candidatura registrada para a vaga “${existedRows[0].vaga}” com o mesmo CPF, enviada em ${toBR(
            enviado
          )}. ` +
          `Conforme nossa política, é necessário aguardar ${daysLeft} dia(s), até ${toBR(
            reapplyDate
          )}, para realizar um novo envio.`,
        enviado_em: enviado.toISOString(),
        pode_reenviar_em: reapplyDate.toISOString(),
      });
    }

    // 3) Upload do arquivo
    const ext = mime.extension(req.file.mimetype) || 'bin';
    const safeNome = slugify(body.nome);
    const safeVaga = slugify(body.vaga);
    const fileId = `${safeVaga}/${cpfNorm || nanoid(6)}-${safeNome}-${Date.now()}-${nanoid(6)}.${ext}`;

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(fileId, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

    if (upErr) {
      console.error('[upload] erro:', upErr);
      return res.status(500).json({ message: 'Falha ao salvar arquivo no Storage.' });
    }

    // 4) URL assinada (30 dias) — opcional
    const { data: signedData, error: signedErr } = await supabase
      .storage
      .from(BUCKET)
      .createSignedUrl(fileId, 60 * 60 * 24 * 30);
    if (signedErr) console.warn('[signed-url] aviso:', signedErr?.message);

    // 5) Inserção no banco (com rollback do arquivo se falhar)
    const payloadDB = {
      nome: body.nome,
      cpf: body.cpf,
      telefone: body.telefone,
      email: body.email,
      cep: body.cep,
      cidade: body.cidade,
      bairro: body.bairro,
      rua: body.rua,
      transporte: body.transporte,
      vaga: body.vaga,
      arquivo_path: fileId,
      arquivo_url: signedData?.signedUrl || null,
      enviado_em: new Date(body.data).toISOString(),
    };

    const { error: dbErr } = await supabase.from('candidaturas').insert(payloadDB);

    if (dbErr) {
      // Índice único como rede de segurança
      if (dbErr.code === '23505') {
        await supabase.storage.from(BUCKET).remove([fileId]).catch(() => {});
        return res.status(409).json({
          ok: false,
          reason: 'duplicate',
          message:
            `Identificamos que já existe uma candidatura registrada para a vaga “${body.vaga}” com o mesmo CPF. ` +
            `Aguarde o período de ${RETENTION_DAYS} dia(s) antes de reenviar.`,
        });
      }
      await supabase.storage.from(BUCKET).remove([fileId]).catch(() => {});
      console.error('[db-insert] erro:', dbErr);
      return res.status(500).json({ message: 'Falha ao gravar dados no banco.' });
    }

    // 6) Sucesso
    return res.json({
      ok: true,
      message:
        'Sua candidatura foi enviada com sucesso. Agradecemos seu interesse e entraremos em contato caso seu perfil seja selecionado.',
    });
  })
);

/* =========================
   /internal/cleanup (90d)
========================= */
app.post(
  '/internal/cleanup',
  asyncRoute(async (req, res) => {
    if (!CLEANUP_TOKEN || req.header('X-CRON-TOKEN') !== CLEANUP_TOKEN) {
      return res.status(401).json({ ok: false, message: 'unauthorized' });
    }

    const windowDays = Math.max(1, Number(process.env.RETENTION_DAYS || RETENTION_DAYS));
    const cutoff = new Date(Date.now() - windowDays * 86400000).toISOString();
    let removed = 0;

    for (let i = 0; i < 50; i++) {
      const { data: rows, error: selErr } = await supabase
        .from('candidaturas')
        .select('id, arquivo_path')
        .lt('enviado_em', cutoff)
        .limit(200);

      if (selErr) {
        console.error('[cleanup/select] erro:', selErr);
        return res.status(500).json({ ok: false, message: 'Falha ao listar registros para limpeza.' });
      }
      if (!rows?.length) break;

      // Remove arquivos
      const paths = rows.map((r) => r.arquivo_path).filter(Boolean);
      if (paths.length) {
        const { error: remErr } = await supabase.storage.from(BUCKET).remove(paths);
        if (remErr) console.warn('[cleanup/storage] aviso:', remErr.message);
      }

      // Remove registros
      const ids = rows.map((r) => r.id);
      const { error: delErr } = await supabase.from('candidaturas').delete().in('id', ids);
      if (delErr) {
        console.error('[cleanup/delete] erro:', delErr);
        return res.status(500).json({ ok: false, message: 'Falha ao excluir registros do banco.' });
      }

      removed += rows.length;
    }

    res.json({ ok: true, removed, cutoff });
  })
);

/* =========================
   404 & ERROR HANDLERS
========================= */
app.use((req, res) => {
  res.status(404).json({ message: 'Rota não encontrada.' });
});

// Middleware central de erros
app.use((err, req, res, next) => {
  // Erro do CORS allowlist
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ message: 'Origem não autorizada por CORS.' });
  }
  // Erros do Multer
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
  console.log(
    `API rodando na porta ${PORT} | Retention: ${RETENTION_DAYS} dias | Bucket: ${BUCKET} | CORS_ORIGIN: ${RAW_ORIGINS}`
  );
});
