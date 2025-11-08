// admin-routes.js - Rotas administrativas separadas
import 'dotenv/config';
import express from 'express';
import { createClient } from '@supabase/supabase-js';

const adminRouter = express.Router();

// Configurações
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin-secret-token';
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

// Supabase
const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '', {
  auth: { persistSession: false },
});

/* =========================
   MIDDLEWARE DE AUTENTICAÇÃO ADMIN
========================= */
function authAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Token de autenticação necessário.' });
  }
  const token = authHeader.substring(7);
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ message: 'Token inválido.' });
  }
  next();
}

/* =========================
   UTILS
========================= */
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Calcular distância usando Google Maps API
async function calcularDistancia(origem, destino) {
  if (!GOOGLE_MAPS_API_KEY) {
    return { error: 'API Key do Google Maps não configurada' };
  }

  try {
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origem)}&destinations=${encodeURIComponent(destino)}&key=${GOOGLE_MAPS_API_KEY}&language=pt-BR`
    );
    
    const data = await response.json();
    
    if (data.status === 'OK' && data.rows[0].elements[0].status === 'OK') {
      const element = data.rows[0].elements[0];
      return {
        distancia: element.distance.text,
        duracao: element.duration.text,
        distancia_metros: element.distance.value,
        duracao_segundos: element.duration.value
      };
    } else {
      return { error: 'Não foi possível calcular a distância' };
    }
  } catch (error) {
    return { error: 'Erro ao calcular distância: ' + error.message };
  }
}

/* =========================
   GET /api/admin/stats
========================= */
adminRouter.get('/stats', authAdmin, asyncRoute(async (req, res) => {
  try {
    // Total de candidaturas
    const { count: total, error: totalError } = await supabase
      .from('candidaturas')
      .select('*', { count: 'exact', head: true });

    if (totalError) throw totalError;

    // Candidaturas dos últimos 30 dias
    const trintaDiasAtras = new Date();
    trintaDiasAtras.setDate(trintaDiasAtras.getDate() - 30);
    
    const { count: ultimos30Dias, error: ultimos30Error } = await supabase
      .from('candidaturas')
      .select('*', { count: 'exact', head: true })
      .gte('enviado_em', trintaDiasAtras.toISOString());

    // Candidaturas por vaga
    const { data: porVaga, error: porVagaError } = await supabase
      .from('candidaturas')
      .select('vaga')
      .then(({ data, error }) => {
        if (error) throw error;
        const counts = {};
        data.forEach(({ vaga }) => {
          counts[vaga] = (counts[vaga] || 0) + 1;
        });
        return { data: Object.entries(counts).map(([vaga, count]) => ({ vaga, count })).sort((a, b) => b.count - a.count) };
      });

    // Candidaturas por cidade
    const { data: porCidade, error: porCidadeError } = await supabase
      .from('candidaturas')
      .select('cidade')
      .then(({ data, error }) => {
        if (error) throw error;
        const counts = {};
        data.forEach(({ cidade }) => {
          counts[cidade] = (counts[cidade] || 0) + 1;
        });
        return { data: Object.entries(counts).map(([cidade, count]) => ({ cidade, count })).sort((a, b) => b.count - a.count).slice(0, 10) };
      });

    // Status de transporte
    const { data: porTransporte, error: porTransporteError } = await supabase
      .from('candidaturas')
      .select('transporte')
      .then(({ data, error }) => {
        if (error) throw error;
        const counts = { 'Sim': 0, 'Não': 0 };
        data.forEach(({ transporte }) => {
          if (transporte === 'Sim' || transporte === 'Não') {
            counts[transporte]++;
          }
        });
        return { data: Object.entries(counts).map(([transporte, count]) => ({ transporte, count })) };
      });

    // Evolução dos últimos 7 dias
    const evolucao = [];
    for (let i = 6; i >= 0; i--) {
      const data = new Date();
      data.setDate(data.getDate() - i);
      const inicioDia = new Date(data.setHours(0, 0, 0, 0));
      const fimDia = new Date(data.setHours(23, 59, 59, 999));
      
      const { count, error } = await supabase
        .from('candidaturas')
        .select('*', { count: 'exact', head: true })
        .gte('enviado_em', inicioDia.toISOString())
        .lte('enviado_em', fimDia.toISOString());

      evolucao.push({
        data: data.toLocaleDateString('pt-BR'),
        count: count || 0
      });
    }

    res.json({
      total: total || 0,
      ultimos30Dias: ultimos30Dias || 0,
      porVaga: porVaga.data || [],
      porCidade: porCidade.data || [],
      porTransporte: porTransporte.data || [],
      evolucao
    });

  } catch (error) {
    console.error('[ADMIN STATS] Erro:', error);
    res.status(500).json({ message: 'Erro ao buscar estatísticas.' });
  }
}));

/* =========================
   GET /api/admin/candidaturas
========================= */
adminRouter.get('/candidaturas', authAdmin, asyncRoute(async (req, res) => {
  const { page = 1, limit = 20, vaga, cidade, transporte, data_inicio, data_fim, search } = req.query;
  const offset = (page - 1) * limit;

  let query = supabase
    .from('candidaturas')
    .select('*', { count: 'exact' })
    .order('enviado_em', { ascending: false });

  // Aplicar filtros
  if (vaga && vaga !== 'todas') query = query.eq('vaga', vaga);
  if (cidade && cidade !== 'todas') query = query.ilike('cidade', `%${cidade}%`);
  if (transporte && transporte !== 'todos') query = query.eq('transporte', transporte);
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
    console.error('[ADMIN CANDIDATURAS] Erro:', error);
    return res.status(500).json({ message: 'Erro ao buscar candidaturas.' });
  }

  res.json({
    candidaturas: data,
    total: count,
    page: Number(page),
    totalPages: Math.ceil(count / limit)
  });
}));

/* =========================
   GET /api/admin/candidaturas/:id
========================= */
adminRouter.get('/candidaturas/:id', authAdmin, asyncRoute(async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('candidaturas')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    console.error('[ADMIN CANDIDATURA] Erro:', error);
    return res.status(500).json({ message: 'Erro ao buscar candidatura.' });
  }

  if (!data) {
    return res.status(404).json({ message: 'Candidatura não encontrada.' });
  }

  res.json(data);
}));

/* =========================
   DELETE /api/admin/candidaturas/:id
========================= */
adminRouter.delete('/candidaturas/:id', authAdmin, asyncRoute(async (req, res) => {
  const { id } = req.params;

  // Buscar a candidatura para obter o arquivo_path
  const { data: candidatura, error: fetchError } = await supabase
    .from('candidaturas')
    .select('arquivo_path')
    .eq('id', id)
    .single();

  if (fetchError) {
    console.error('[ADMIN DELETE] Erro ao buscar candidatura:', fetchError);
    return res.status(500).json({ message: 'Erro ao buscar candidatura.' });
  }

  if (!candidatura) {
    return res.status(404).json({ message: 'Candidatura não encontrada.' });
  }

  // Excluir o arquivo do storage
  if (candidatura.arquivo_path) {
    const { error: storageError } = await supabase.storage
      .from('curriculos')
      .remove([candidatura.arquivo_path]);

    if (storageError) {
      console.error('[ADMIN DELETE] Erro ao excluir arquivo:', storageError);
    }
  }

  // Excluir o registro do banco
  const { error: deleteError } = await supabase
    .from('candidaturas')
    .delete()
    .eq('id', id);

  if (deleteError) {
    console.error('[ADMIN DELETE] Erro ao excluir candidatura:', deleteError);
    return res.status(500).json({ message: 'Erro ao excluir candidatura.' });
  }

  res.json({ ok: true, message: 'Candidatura excluída com sucesso.' });
}));

/* =========================
   GET /api/admin/vagas
========================= */
adminRouter.get('/vagas', authAdmin, asyncRoute(async (req, res) => {
  const { data, error } = await supabase
    .from('vagas')
    .select('*')
    .order('nome', { ascending: true });

  if (error) {
    console.error('[ADMIN VAGAS] Erro:', error);
    return res.status(500).json({ message: 'Erro ao buscar vagas.' });
  }

  res.json(data || []);
}));

/* =========================
   POST /api/admin/vagas
========================= */
adminRouter.post('/vagas', authAdmin, asyncRoute(async (req, res) => {
  const { nome, ativa = true } = req.body;

  if (!nome) {
    return res.status(400).json({ message: 'Nome da vaga é obrigatório.' });
  }

  const { data, error } = await supabase
    .from('vagas')
    .insert([{ nome, ativa }])
    .select();

  if (error) {
    console.error('[ADMIN VAGAS] Erro ao criar:', error);
    return res.status(500).json({ message: 'Erro ao criar vaga.' });
  }

  res.json(data[0]);
}));

/* =========================
   PUT /api/admin/vagas/:id
========================= */
adminRouter.put('/vagas/:id', authAdmin, asyncRoute(async (req, res) => {
  const { id } = req.params;
  const { nome, ativa } = req.body;

  const { data, error } = await supabase
    .from('vagas')
    .update({ nome, ativa })
    .eq('id', id)
    .select();

  if (error) {
    console.error('[ADMIN VAGAS] Erro ao atualizar:', error);
    return res.status(500).json({ message: 'Erro ao atualizar vaga.' });
  }

  if (data.length === 0) {
    return res.status(404).json({ message: 'Vaga não encontrada.' });
  }

  res.json(data[0]);
}));

/* =========================
   DELETE /api/admin/vagas/:id
========================= */
adminRouter.delete('/vagas/:id', authAdmin, asyncRoute(async (req, res) => {
  const { id } = req.params;

  const { error } = await supabase
    .from('vagas')
    .delete()
    .eq('id', id);

  if (error) {
    console.error('[ADMIN VAGAS] Erro ao deletar:', error);
    return res.status(500).json({ message: 'Erro ao deletar vaga.' });
  }

  res.json({ message: 'Vaga deletada com sucesso.' });
}));

/* =========================
   GET /api/admin/filtros
========================= */
adminRouter.get('/filtros', authAdmin, asyncRoute(async (req, res) => {
  try {
    // Buscar valores únicos para os filtros
    const { data: vagas, error: vagasError } = await supabase
      .from('candidaturas')
      .select('vaga')
      .then(({ data, error }) => {
        if (error) throw error;
        const unique = [...new Set(data.map(item => item.vaga))];
        return { data: unique.filter(Boolean) };
      });

    const { data: cidades, error: cidadesError } = await supabase
      .from('candidaturas')
      .select('cidade')
      .then(({ data, error }) => {
        if (error) throw error;
        const unique = [...new Set(data.map(item => item.cidade))];
        return { data: unique.filter(Boolean) };
      });

    if (vagasError || cidadesError) {
      throw vagasError || cidadesError;
    }

    res.json({
      vagas: vagas.data,
      cidades: cidades.data
    });

  } catch (error) {
    console.error('[ADMIN FILTROS] Erro:', error);
    res.status(500).json({ message: 'Erro ao buscar opções de filtro.' });
  }
}));

/* =========================
   POST /api/admin/calcular-distancia
========================= */
adminRouter.post('/calcular-distancia', authAdmin, asyncRoute(async (req, res) => {
  const { enderecoCandidato, enderecoTrabalho } = req.body;

  if (!enderecoCandidato || !enderecoTrabalho) {
    return res.status(400).json({ message: 'Endereço do candidato e do trabalho são obrigatórios.' });
  }

  try {
    const resultado = await calcularDistancia(enderecoCandidato, enderecoTrabalho);
    
    if (resultado.error) {
      return res.status(400).json({ message: resultado.error });
    }

    res.json(resultado);
  } catch (error) {
    console.error('[DISTANCIA] Erro:', error);
    res.status(500).json({ message: 'Erro ao calcular distância.' });
  }
}));

/* =========================
   GET /api/admin/geolocalizacao
========================= */
adminRouter.get('/geolocalizacao', authAdmin, asyncRoute(async (req, res) => {
  // Esta rota pode ser usada para obter a localização atual do mercado/trabalho
  // Em produção, isso viria de uma configuração do sistema
  res.json({
    enderecoTrabalho: process.env.ENDERECO_TRABALHO || 'Av. Paulista, 1000 - São Paulo, SP',
    coordenadas: {
      lat: process.env.LAT_TRABALHO || -23.563,
      lng: process.env.LNG_TRABALHO || -46.654
    }
  });
}));

export default adminRouter;
