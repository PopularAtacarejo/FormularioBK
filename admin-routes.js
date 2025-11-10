// admin-routes.js - Rotas administrativas atualizadas
import 'dotenv/config';
import express from 'express';
import { createClient } from '@supabase/supabase-js';

const adminRouter = express.Router();

// Configurações
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin-secret-token';

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

// Endereço fixo do mercado
const ENDERECO_MERCADO = 'Km 91, AL-220, 948 - Sen. Arnon de Melo, Arapiraca - AL, 57315-745';
const COORDENADAS_MERCADO = { lat: -9.7512, lon: -36.6574 };

// Geocodificação usando Nominatim (OpenStreetMap) - Gratuito
async function geocodificarEndereco(endereco) {
  try {
    // Delay para respeitar a política de uso do Nominatim
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(endereco)}&limit=1&countrycodes=br&addressdetails=1`,
      {
        headers: {
          'User-Agent': 'SistemaRHCurriculos/1.0',
          'Accept-Language': 'pt-BR,pt;q=0.9'
        }
      }
    );
    
    const data = await response.json();
    
    if (data && data.length > 0) {
      return {
        lat: parseFloat(data[0].lat),
        lon: parseFloat(data[0].lon),
        endereco: data[0].display_name,
        tipo: data[0].type,
        importancia: data[0].importance
      };
    }
    return null;
  } catch (error) {
    console.error('Erro na geocodificação:', error);
    return null;
  }
}

// Calcular distância em linha reta usando a fórmula de Haversine
function calcularDistanciaEmLinhaReta(lat1, lon1, lat2, lon2) {
  const R = 6371; // Raio da Terra em km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distancia = R * c;
  return distancia;
}

// Calcular tempo estimado baseado na distância e tipo de área
function calcularTempoEstimado(distanciaKm, cidadeOrigem) {
  // Verificar se é na mesma cidade
  const mesmaCidade = cidadeOrigem.toLowerCase().includes('arapiraca');
  
  if (mesmaCidade) {
    // Em mesma cidade, velocidade média de 30km/h
    const tempoMinutos = Math.round((distanciaKm / 30) * 60);
    return Math.max(tempoMinutos, 5); // Mínimo 5 minutos
  } else {
    // Entre cidades, velocidade média de 60km/h
    const tempoMinutos = Math.round((distanciaKm / 60) * 60);
    return Math.max(tempoMinutos, 15); // Mínimo 15 minutos
  }
}

/* =========================
   POST /api/admin/calcular-distancia
========================= */
adminRouter.post('/calcular-distancia', authAdmin, asyncRoute(async (req, res) => {
  const { enderecoCandidato, enderecoTrabalho = ENDERECO_MERCADO } = req.body;

  if (!enderecoCandidato) {
    return res.status(400).json({ message: 'Endereço do candidato é obrigatório.' });
  }

  try {
    // Geocodificar endereço do candidato
    const coordsCandidato = await geocodificarEndereco(enderecoCandidato);
    
    if (!coordsCandidato) {
      return res.status(400).json({ 
        message: 'Não foi possível encontrar o endereço do candidato. Verifique se o endereço está completo.' 
      });
    }

    // Usar coordenadas fixas do mercado
    const distanciaKm = calcularDistanciaEmLinhaReta(
      coordsCandidato.lat,
      coordsCandidato.lon,
      COORDENADAS_MERCADO.lat,
      COORDENADAS_MERCADO.lon
    );

    // Calcular tempo estimado
    const tempoMinutos = calcularTempoEstimado(distanciaKm, enderecoCandidato);

    // Formatar resposta
    const resposta = {
      distancia: `${distanciaKm.toFixed(1)} km`,
      duracao: `${tempoMinutos} minutos`,
      distancia_km: parseFloat(distanciaKm.toFixed(1)),
      duracao_minutos: tempoMinutos,
      metodo: 'calculadora_gratuita',
      coordenadas_candidato: coordsCandidato,
      observacao: 'Distância calculada em linha reta. Tempo estimado considerando tráfego local.'
    };

    // Adicionar observação específica se for muito próximo
    if (distanciaKm < 2) {
      resposta.observacao += ' Localização muito próxima do mercado.';
    } else if (distanciaKm > 50) {
      resposta.observacao += ' Candidato em cidade diferente.';
    }

    res.json(resposta);

  } catch (error) {
    console.error('[DISTANCIA] Erro:', error);
    res.status(500).json({ message: 'Erro ao calcular distância.' });
  }
}));

/* =========================
   GET /api/admin/geolocalizacao
========================= */
adminRouter.get('/geolocalizacao', authAdmin, asyncRoute(async (req, res) => {
  res.json({
    enderecoTrabalho: ENDERECO_MERCADO,
    coordenadas: {
      lat: COORDENADAS_MERCADO.lat,
      lng: COORDENADAS_MERCADO.lon
    },
    nomeLocal: 'Mercado Arapiraca - AL'
  });
}));

/* =========================
   GET /api/admin/geocodificar
========================= */
adminRouter.get('/geocodificar', authAdmin, asyncRoute(async (req, res) => {
  const { endereco } = req.query;
  
  if (!endereco) {
    return res.status(400).json({ message: 'Endereço é obrigatório.' });
  }

  try {
    const resultado = await geocodificarEndereco(endereco);
    
    if (!resultado) {
      return res.status(404).json({ message: 'Endereço não encontrado.' });
    }

    res.json(resultado);
  } catch (error) {
    console.error('[GEOCODIFICAR] Erro:', error);
    res.status(500).json({ message: 'Erro ao geocodificar endereço.' });
  }
}));

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

    // Candidatos de Arapiraca
    const { count: arapiracaCount, error: arapiracaError } = await supabase
      .from('candidaturas')
      .select('*', { count: 'exact', head: true })
      .ilike('cidade', '%arapiraca%');

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

    // Estatísticas por status
    const { data: porStatus, error: porStatusError } = await supabase
      .from('candidaturas')
      .select('status')
      .then(({ data, error }) => {
        if (error) throw error;
        const counts = {};
        data.forEach(({ status }) => {
          counts[status] = (counts[status] || 0) + 1;
        });
        return { data: Object.entries(counts).map(([status, count]) => ({ status, count })) };
      });

    res.json({
      total: total || 0,
      ultimos30Dias: ultimos30Dias || 0,
      arapiraca: arapiracaCount || 0,
      porVaga: porVaga.data || [],
      porCidade: porCidade.data || [],
      porTransporte: porTransporte.data || [],
      porStatus: porStatus.data || [],
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
    .select(`
      *,
      usuario_status:usuarios!status_alterado_por(nome, email, cargo, funcao, nivel)
    `)
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

    const { data: status, error: statusError } = await supabase
      .from('candidaturas')
      .select('status')
      .then(({ data, error }) => {
        if (error) throw error;
        const unique = [...new Set(data.map(item => item.status))];
        return { data: unique.filter(Boolean) };
      });

    if (vagasError || cidadesError || statusError) {
      throw vagasError || cidadesError || statusError;
    }

    res.json({
      vagas: vagas.data,
      cidades: cidades.data,
      status: status.data
    });

  } catch (error) {
    console.error('[ADMIN FILTROS] Erro:', error);
    res.status(500).json({ message: 'Erro ao buscar opções de filtro.' });
  }
}));

export default adminRouter;
