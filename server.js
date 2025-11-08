import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { createClient } from '@supabase/supabase-js';
import mime from 'mime-types';

const app = express();

// CORS
const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(cors({ origin: corsOrigin }));

// Healthcheck leve (para “acordar” o Render)
app.get('/health', (_, res) => res.json({ ok: true }));

// Multer (memória) + limites + filtro de tipo
const maxFileMB = Number(process.env.MAX_FILE_MB || 5);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxFileMB * 1024 * 1024 },
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

// Supabase client (usar SERVICE_ROLE só aqui no backend)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const BUCKET = process.env.SUPABASE_BUCKET || 'curriculos';

// helpers
const slugify = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

// RECEBER CANDIDATURA
app.post('/api/enviar', upload.single('arquivo'), async (req, res) => {
  try {
    const {
      nome = '',
      cpf = '',
      telefone = '',
      email = '',
      cep = '',
      cidade = '',
      bairro = '',
      rua = '',
      transporte = '',
      vaga = '',
      data = new Date().toISOString(),
    } = req.body;

    if (!req.file) return res.status(400).send('Arquivo é obrigatório.');
    if (!nome || !cpf || !telefone || !email || !cep || !cidade || !bairro || !rua || !transporte || !vaga) {
      return res.status(400).send('Campos obrigatórios não preenchidos.');
    }

    // Caminho do arquivo
    const ext = mime.extension(req.file.mimetype) || 'bin';
    const safeNome = slugify(nome);
    const safeVaga = slugify(vaga);
    const safeCPF = String(cpf).replace(/\D/g, '').slice(0, 11) || nanoid(6);
    const fileId = `${safeVaga}/${safeCPF}-${safeNome}-${Date.now()}-${nanoid(6)}.${ext}`;

    // Upload ao Storage
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(fileId, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    if (upErr) {
      console.error(upErr);
      return res.status(500).send('Falha ao salvar arquivo no Storage.');
    }

    // URL assinada opcional (30 dias)
    let signedUrl = null;
    const { data: signedData, error: signedErr } = await supabase
      .storage
      .from(BUCKET)
      .createSignedUrl(fileId, 60 * 60 * 24 * 30);
    if (!signedErr) signedUrl = signedData?.signedUrl;

    // Inserção no banco
    const { error: dbErr } = await supabase
      .from('candidaturas')
      .insert({
        nome,
        cpf,
        telefone,
        email,
        cep,
        cidade,
        bairro,
        rua,
        transporte,
        vaga,
        arquivo_path: fileId,
        arquivo_url: signedUrl,
        enviado_em: new Date(data).toISOString(),
      });

    if (dbErr) {
      // 23505 = unique_violation (índice único cpf_norm+vaga_norm)
      if (dbErr.code === '23505') {
        return res.status(409).json({
          ok: false,
          message: 'Você já se candidatou para esta vaga com este CPF. Caso deseje, escolha outra vaga.',
        });
      }
      console.error(dbErr);
      return res.status(500).send('Falha ao gravar dados no banco.');
    }

    return res.status(200).json({ ok: true, message: 'Candidatura recebida com sucesso!' });
  } catch (e) {
    console.error(e);
    const msg = e?.message?.includes('Formato inválido') ? e.message : 'Erro inesperado ao processar candidatura.';
    return res.status(400).send(msg);
  }
});

// LIMPEZA 90 DIAS (chamado por agendador externo)
app.post('/internal/cleanup', async (req, res) => {
  try {
    const token = req.header('X-CRON-TOKEN');
    if (!token || token !== process.env.CLEANUP_TOKEN) {
      return res.status(401).json({ ok: false, message: 'unauthorized' });
    }

    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    let totalRemoved = 0;

    for (let loops = 0; loops < 50; loops++) {
      const { data: rows, error: selErr } = await supabase
        .from('candidaturas')
        .select('id, arquivo_path')
        .lt('enviado_em', cutoff)
        .limit(200);

      if (selErr) {
        console.error(selErr);
        return res.status(500).json({ ok: false, message: 'Falha ao consultar registros.' });
      }
      if (!rows || rows.length === 0) break;

      const paths = rows.map(r => r.arquivo_path).filter(Boolean);
      if (paths.length > 0) {
        const { error: remErr } = await supabase.storage.from(BUCKET).remove(paths);
        if (remErr) console.warn('Falha ao remover alguns arquivos do Storage:', remErr.message);
      }

      const ids = rows.map(r => r.id);
      const { error: delErr } = await supabase
        .from('candidaturas')
        .delete()
        .in('id', ids);

      if (delErr) {
        console.error(delErr);
        return res.status(500).json({ ok: false, message: 'Falha ao remover registros do banco.' });
      }

      totalRemoved += rows.length;
    }

    return res.json({ ok: true, removed: totalRemoved, cutoff });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: 'Erro no cleanup.' });
  }
});

// start
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`API rodando na porta ${PORT}`));
