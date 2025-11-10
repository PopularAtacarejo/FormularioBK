// user-routes.js - Sistema completo de usuários, status e comentários
import 'dotenv/config';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';

const userRouter = express.Router();

// Configurações
const JWT_SECRET = process.env.JWT_SECRET || 'seu-jwt-secreto-aqui';

// Supabase
const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '', {
  auth: { persistSession: false },
});

/* =========================
   CONSTANTES E CONFIGURAÇÕES
========================= */
const NIVEL_USUARIO = {
  ADMIN: 'admin',
  LIDER: 'lider', 
  ANALISTA: 'analista'
};

const STATUS_CANDIDATURA = {
  NOVO: 'Novo',
  SELECIONADO: 'Selecionado',
  NAO_ATENDEU: 'Não Atendeu a Ligação',
  DESISTIU: 'Desistiu',
  JA_TRABALHOU: 'Já trabalhou Aqui',
  PASSOU_ENTREVISTA: 'Passou na Entrevista',
  JA_TRABALHANDO: 'Já está trabalhando',
  CONTRATADO: 'Contratado'
};

/* =========================
   MIDDLEWARE DE AUTENTICAÇÃO
========================= */
function authUser(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Token de autenticação necessário.' });
  }

  const token = authHeader.substring(7);
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Token inválido ou expirado.' });
  }
}

// Middleware para admin
function authAdmin(req, res, next) {
  if (!req.user || req.user.nivel !== NIVEL_USUARIO.ADMIN) {
    return res.status(403).json({ message: 'Acesso restrito a administradores gerais.' });
  }
  next();
}

// Middleware para líder ou admin
function authLider(req, res, next) {
  if (!req.user || !([NIVEL_USUARIO.ADMIN, NIVEL_USUARIO.LIDER].includes(req.user.nivel))) {
    return res.status(403).json({ message: 'Acesso restrito a líderes e administradores.' });
  }
  next();
}

// Middleware para analista, líder ou admin
function authAnalista(req, res, next) {
  if (!req.user || !([NIVEL_USUARIO.ADMIN, NIVEL_USUARIO.LIDER, NIVEL_USUARIO.ANALISTA].includes(req.user.nivel))) {
    return res.status(403).json({ message: 'Acesso restrito.' });
  }
  next();
}

/* =========================
   UTILS
========================= */
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* =========================
   ROTAS DE AUTENTICAÇÃO
========================= */

// POST /api/users/login
userRouter.post('/login', asyncRoute(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email e senha são obrigatórios.' });
  }

  try {
    // Buscar usuário pelo email
    const { data: user, error } = await supabase
      .from('usuarios')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();

    if (error || !user) {
      return res.status(401).json({ message: 'Credenciais inválidas.' });
    }

    // Verificar senha
    const validPassword = await bcrypt.compare(password, user.senha);
    if (!validPassword) {
      return res.status(401).json({ message: 'Credenciais inválidas.' });
    }

    // Verificar se usuário está ativo
    if (!user.ativo) {
      return res.status(401).json({ message: 'Usuário desativado. Contate o administrador.' });
    }

    // Gerar token JWT
    const token = jwt.sign(
      { 
        id: user.id, 
        email: user.email, 
        nome: user.nome,
        cargo: user.cargo,
        funcao: user.funcao,
        nivel: user.nivel
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      ok: true,
      message: 'Login realizado com sucesso.',
      token,
      user: {
        id: user.id,
        nome: user.nome,
        email: user.email,
        cargo: user.cargo,
        funcao: user.funcao,
        nivel: user.nivel
      }
    });

  } catch (error) {
    console.error('[USER LOGIN] Erro:', error);
    res.status(500).json({ message: 'Erro interno no servidor.' });
  }
}));

// GET /api/users/me - Verificar token e obter dados do usuário
userRouter.get('/me', authUser, asyncRoute(async (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      nome: req.user.nome,
      email: req.user.email,
      cargo: req.user.cargo,
      funcao: req.user.funcao,
      nivel: req.user.nivel
    }
  });
}));

// PUT /api/users/change-password - Alterar senha
userRouter.put('/change-password', authUser, asyncRoute(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ message: 'Senha atual e nova senha são obrigatórias.' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ message: 'A nova senha deve ter pelo menos 6 caracteres.' });
  }

  try {
    // Buscar usuário atual
    const { data: user, error } = await supabase
      .from('usuarios')
      .select('senha')
      .eq('id', req.user.id)
      .single();

    if (error || !user) {
      return res.status(404).json({ message: 'Usuário não encontrado.' });
    }

    // Verificar senha atual
    const validPassword = await bcrypt.compare(currentPassword, user.senha);
    if (!validPassword) {
      return res.status(401).json({ message: 'Senha atual incorreta.' });
    }

    // Hash da nova senha
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Atualizar senha
    const { error: updateError } = await supabase
      .from('usuarios')
      .update({ senha: hashedPassword })
      .eq('id', req.user.id);

    if (updateError) {
      throw updateError;
    }

    res.json({ ok: true, message: 'Senha alterada com sucesso.' });

  } catch (error) {
    console.error('[CHANGE PASSWORD] Erro:', error);
    res.status(500).json({ message: 'Erro ao alterar senha.' });
  }
}));

/* =========================
   ROTAS DE STATUS DAS CANDIDATURAS
========================= */

// GET /api/users/status - Listar todos os status disponíveis
userRouter.get('/status', authUser, asyncRoute(async (req, res) => {
  res.json({
    status: Object.values(STATUS_CANDIDATURA),
    niveis: Object.values(NIVEL_USUARIO)
  });
}));

// GET /api/users/candidaturas/:id/status - Histórico de status de uma candidatura
userRouter.get('/candidaturas/:id/status', authAnalista, asyncRoute(async (req, res) => {
  const { id } = req.params;

  const { data: historico, error } = await supabase
    .from('status_candidaturas')
    .select(`
      *,
      usuario:usuarios(nome, email, cargo, funcao, nivel)
    `)
    .eq('candidatura_id', id)
    .order('criado_em', { ascending: false });

  if (error) {
    console.error('[STATUS] Erro ao buscar histórico:', error);
    return res.status(500).json({ message: 'Erro ao buscar histórico de status.' });
  }

  res.json(historico || []);
}));

// PUT /api/users/candidaturas/:id/status - Alterar status da candidatura
userRouter.put('/candidaturas/:id/status', authAnalista, asyncRoute(async (req, res) => {
  const { id } = req.params;
  const { status, observacao } = req.body;

  if (!status) {
    return res.status(400).json({ message: 'Status é obrigatório.' });
  }

  // Validar status
  if (!Object.values(STATUS_CANDIDATURA).includes(status)) {
    return res.status(400).json({ message: 'Status inválido.' });
  }

  try {
    // Verificar se a candidatura existe
    const { data: candidatura, error: candidaturaError } = await supabase
      .from('candidaturas')
      .select('*')
      .eq('id', id)
      .single();

    if (candidaturaError || !candidatura) {
      return res.status(404).json({ message: 'Candidatura não encontrada.' });
    }

    // Registrar no histórico de status
    const { data: novoStatus, error: statusError } = await supabase
      .from('status_candidaturas')
      .insert([{
        candidatura_id: id,
        usuario_id: req.user.id,
        status,
        observacao: observacao || null,
        criado_em: new Date().toISOString()
      }])
      .select(`
        *,
        usuario:usuarios(nome, email, cargo, funcao, nivel)
      `)
      .single();

    if (statusError) {
      throw statusError;
    }

    // Atualizar status atual na candidatura
    const { error: updateError } = await supabase
      .from('candidaturas')
      .update({
        status,
        status_alterado_por: req.user.id,
        status_alterado_em: new Date().toISOString()
      })
      .eq('id', id);

    if (updateError) {
      throw updateError;
    }

    res.json({
      ok: true,
      message: 'Status atualizado com sucesso.',
      status: novoStatus,
      candidatura_id: id
    });

  } catch (error) {
    console.error('[STATUS] Erro ao atualizar:', error);
    res.status(500).json({ message: 'Erro ao atualizar status da candidatura.' });
  }
}));

/* =========================
   ROTAS DE COMENTÁRIOS
========================= */

// GET /api/users/comentarios/:candidaturaId - Listar comentários de uma candidatura
userRouter.get('/comentarios/:candidaturaId', authAnalista, asyncRoute(async (req, res) => {
  const { candidaturaId } = req.params;

  const { data: comentarios, error } = await supabase
    .from('comentarios')
    .select(`
      *,
      usuario:usuarios(nome, cargo, funcao, nivel)
    `)
    .eq('candidatura_id', candidaturaId)
    .order('criado_em', { ascending: false });

  if (error) {
    console.error('[COMENTARIOS] Erro ao buscar:', error);
    return res.status(500).json({ message: 'Erro ao buscar comentários.' });
  }

  res.json(comentarios || []);
}));

// POST /api/users/comentarios - Criar comentário
userRouter.post('/comentarios', authAnalista, asyncRoute(async (req, res) => {
  const { candidatura_id, comentario, tipo = 'observacao' } = req.body;

  if (!candidatura_id || !comentario) {
    return res.status(400).json({ message: 'Candidatura e comentário são obrigatórios.' });
  }

  if (comentario.length > 1000) {
    return res.status(400).json({ message: 'Comentário muito longo. Máximo 1000 caracteres.' });
  }

  try {
    const novoComentario = {
      candidatura_id,
      usuario_id: req.user.id,
      comentario: comentario.trim(),
      tipo,
      criado_em: new Date().toISOString(),
      atualizado_em: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('comentarios')
      .insert([novoComentario])
      .select(`
        *,
        usuario:usuarios(nome, cargo, funcao, nivel)
      `)
      .single();

    if (error) {
      throw error;
    }

    res.status(201).json(data);

  } catch (error) {
    console.error('[COMENTARIOS] Erro ao criar:', error);
    res.status(500).json({ message: 'Erro ao criar comentário.' });
  }
}));

// PUT /api/users/comentarios/:id - Atualizar comentário
userRouter.put('/comentarios/:id', authUser, asyncRoute(async (req, res) => {
  const { id } = req.params;
  const { comentario } = req.body;

  if (!comentario) {
    return res.status(400).json({ message: 'Comentário é obrigatório.' });
  }

  if (comentario.length > 1000) {
    return res.status(400).json({ message: 'Comentário muito longo. Máximo 1000 caracteres.' });
  }

  try {
    // Buscar comentário
    const { data: comentarioExistente, error: fetchError } = await supabase
      .from('comentarios')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !comentarioExistente) {
      return res.status(404).json({ message: 'Comentário não encontrado.' });
    }

    // Verificar permissão (usuário dono ou admin)
    if (comentarioExistente.usuario_id !== req.user.id && req.user.nivel !== NIVEL_USUARIO.ADMIN) {
      return res.status(403).json({ message: 'Você só pode editar seus próprios comentários.' });
    }

    // Atualizar comentário
    const { data, error } = await supabase
      .from('comentarios')
      .update({
        comentario: comentario.trim(),
        atualizado_em: new Date().toISOString()
      })
      .eq('id', id)
      .select(`
        *,
        usuario:usuarios(nome, cargo, funcao, nivel)
      `)
      .single();

    if (error) {
      throw error;
    }

    res.json(data);

  } catch (error) {
    console.error('[COMENTARIOS] Erro ao atualizar:', error);
    res.status(500).json({ message: 'Erro ao atualizar comentário.' });
  }
}));

// DELETE /api/users/comentarios/:id - Excluir comentário
userRouter.delete('/comentarios/:id', authUser, asyncRoute(async (req, res) => {
  const { id } = req.params;

  try {
    // Buscar comentário
    const { data: comentarioExistente, error: fetchError } = await supabase
      .from('comentarios')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !comentarioExistente) {
      return res.status(404).json({ message: 'Comentário não encontrado.' });
    }

    // Verificar permissão (usuário dono ou admin)
    if (comentarioExistente.usuario_id !== req.user.id && req.user.nivel !== NIVEL_USUARIO.ADMIN) {
      return res.status(403).json({ message: 'Você só pode excluir seus próprios comentários.' });
    }

    // Excluir comentário
    const { error } = await supabase
      .from('comentarios')
      .delete()
      .eq('id', id);

    if (error) {
      throw error;
    }

    res.json({ ok: true, message: 'Comentário excluído com sucesso.' });

  } catch (error) {
    console.error('[COMENTARIOS] Erro ao excluir:', error);
    res.status(500).json({ message: 'Erro ao excluir comentário.' });
  }
}));

/* =========================
   ROTAS DE CANDIDATURAS PARA USUÁRIOS
========================= */

// GET /api/users/candidaturas - Listar candidaturas com filtros
userRouter.get('/candidaturas', authAnalista, asyncRoute(async (req, res) => {
  const { page = 1, limit = 20, vaga, cidade, transporte, data_inicio, data_fim, search, status } = req.query;
  const offset = (page - 1) * limit;

  let query = supabase
    .from('candidaturas')
    .select(`
      *,
      usuario_status:usuarios!status_alterado_por(nome, email, cargo, funcao, nivel)
    `, { count: 'exact' })
    .order('enviado_em', { ascending: false });

  // Aplicar filtros
  if (vaga && vaga !== 'todas') query = query.eq('vaga', vaga);
  if (cidade && cidade !== 'todas') query = query.ilike('cidade', `%${cidade}%`);
  if (transporte && transporte !== 'todos') query = query.eq('transporte', transporte);
  if (status && status !== 'todos') query = query.eq('status', status);
  if (search) {
    query = query.or(`nome.ilike.%${search}%,email.ilike.%${search}%,cpf.ilike.%${search}%`);
  }
  
  if (data_inicio) {
    query = query.gte('enviado_em', new Date(data_inicio).toISOString());
  }
  if (data_fim) {
    const endDate = new Date(data_fim);
    endDate.setHours(23, 59, 59, 999);
    query = query.lte('enviado_em', endDate.toISOString());
  }

  const { data, error, count } = await query.range(offset, offset + limit - 1);

  if (error) {
    console.error('[USER CANDIDATURAS] Erro:', error);
    return res.status(500).json({ message: 'Erro ao buscar candidaturas.' });
  }

  res.json({
    candidaturas: data,
    total: count,
    page: Number(page),
    totalPages: Math.ceil(count / limit)
  });
}));

// GET /api/users/candidaturas/:id - Buscar candidatura específica
userRouter.get('/candidaturas/:id', authAnalista, asyncRoute(async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('candidaturas')
    .select(`
      *,
      usuario_status:usuarios!status_alterado_por(nome, email, cargo, funcao, nivel)
    `)
    .eq('id', id)
    .single();

  if (error) {
    console.error('[USER CANDIDATURA] Erro:', error);
    return res.status(500).json({ message: 'Erro ao buscar candidatura.' });
  }

  if (!data) {
    return res.status(404).json({ message: 'Candidatura não encontrada.' });
  }

  res.json(data);
}));

/* =========================
   ROTAS ADMINISTRATIVAS DE USUÁRIOS (apenas admin)
========================= */

// GET /api/users - Listar todos os usuários (apenas admin)
userRouter.get('/', authUser, authAdmin, asyncRoute(async (req, res) => {
  const { data: usuarios, error } = await supabase
    .from('usuarios')
    .select('id, nome, email, cargo, funcao, nivel, ativo, criado_em')
    .order('nome');

  if (error) {
    console.error('[USUARIOS] Erro ao buscar:', error);
    return res.status(500).json({ message: 'Erro ao buscar usuários.' });
  }

  res.json(usuarios || []);
}));

// POST /api/users - Criar usuário (apenas admin)
userRouter.post('/', authUser, authAdmin, asyncRoute(async (req, res) => {
  const { nome, email, cargo, funcao, password, nivel = 'analista' } = req.body;

  if (!nome || !email || !cargo || !funcao || !password) {
    return res.status(400).json({ message: 'Todos os campos são obrigatórios.' });
  }

  if (!Object.values(NIVEL_USUARIO).includes(nivel)) {
    return res.status(400).json({ message: 'Nível de usuário inválido.' });
  }

  if (password.length < 6) {
    return res.status(400).json({ message: 'A senha deve ter pelo menos 6 caracteres.' });
  }

  try {
    // Verificar se email já existe
    const { data: usuarioExistente, error: checkError } = await supabase
      .from('usuarios')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();

    if (usuarioExistente) {
      return res.status(409).json({ message: 'Já existe um usuário com este email.' });
    }

    // Hash da senha
    const hashedPassword = await bcrypt.hash(password, 10);

    const novoUsuario = {
      nome: nome.trim(),
      email: email.toLowerCase().trim(),
      cargo: cargo.trim(),
      funcao: funcao.trim(),
      senha: hashedPassword,
      nivel: nivel,
      ativo: true,
      criado_em: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('usuarios')
      .insert([novoUsuario])
      .select('id, nome, email, cargo, funcao, nivel, ativo, criado_em')
      .single();

    if (error) {
      throw error;
    }

    res.status(201).json(data);

  } catch (error) {
    console.error('[USUARIOS] Erro ao criar:', error);
    res.status(500).json({ message: 'Erro ao criar usuário.' });
  }
}));

// PUT /api/users/:id - Atualizar usuário (apenas admin)
userRouter.put('/:id', authUser, authAdmin, asyncRoute(async (req, res) => {
  const { id } = req.params;
  const { nome, email, cargo, funcao, nivel, ativo } = req.body;

  try {
    const updates = {
      nome: nome?.trim(),
      email: email?.toLowerCase().trim(),
      cargo: cargo?.trim(),
      funcao: funcao?.trim(),
      nivel,
      ativo
    };

    // Validar nível
    if (nivel && !Object.values(NIVEL_USUARIO).includes(nivel)) {
      return res.status(400).json({ message: 'Nível de usuário inválido.' });
    }

    // Remover campos undefined
    Object.keys(updates).forEach(key => updates[key] === undefined && delete updates[key]);

    const { data, error } = await supabase
      .from('usuarios')
      .update(updates)
      .eq('id', id)
      .select('id, nome, email, cargo, funcao, nivel, ativo, criado_em')
      .single();

    if (error) {
      throw error;
    }

    if (!data) {
      return res.status(404).json({ message: 'Usuário não encontrado.' });
    }

    res.json(data);

  } catch (error) {
    console.error('[USUARIOS] Erro ao atualizar:', error);
    res.status(500).json({ message: 'Erro ao atualizar usuário.' });
  }
}));

// DELETE /api/users/:id - Excluir usuário (apenas admin)
userRouter.delete('/:id', authUser, authAdmin, asyncRoute(async (req, res) => {
  const { id } = req.params;

  // Não permitir excluir a si mesmo
  if (id === req.user.id) {
    return res.status(400).json({ message: 'Você não pode excluir sua própria conta.' });
  }

  try {
    const { error } = await supabase
      .from('usuarios')
      .delete()
      .eq('id', id);

    if (error) {
      throw error;
    }

    res.json({ ok: true, message: 'Usuário excluído com sucesso.' });

  } catch (error) {
    console.error('[USUARIOS] Erro ao excluir:', error);
    res.status(500).json({ message: 'Erro ao excluir usuário.' });
  }
}));

export default userRouter;
