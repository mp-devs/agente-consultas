-- ============================================================
-- Agente de Consultas — Meu Pescado
-- Schema Postgres (mesmo banco do n8n ou um banco dedicado)
-- ============================================================
-- Rodar com:  psql "$PG_URL" -f sql/schema.sql

-- ------------------------------------------------------------
-- 1. Memória de conversa
-- ------------------------------------------------------------
-- Usada pelo nó "Postgres Chat Memory" do n8n.
-- O n8n cria a tabela sozinho no primeiro uso, mas criar aqui
-- garante os índices certos (sem eles, a leitura de memória vira
-- seq scan e degrada rápido com o volume de mensagens).
CREATE TABLE IF NOT EXISTS agente_memoria (
    id          SERIAL PRIMARY KEY,
    session_id  VARCHAR(255) NOT NULL,
    message     JSONB        NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memoria_sessao
    ON agente_memoria (session_id, id DESC);

-- ------------------------------------------------------------
-- 2. Auditoria / log de conversas
-- ------------------------------------------------------------
-- Fonte de verdade para: cobrança de custo de LLM, depuração,
-- e — principalmente — descobrir QUAIS perguntas o agente não
-- consegue responder. É esse log que prioriza a próxima leva de
-- endpoints, não o nosso palpite.
CREATE TABLE IF NOT EXISTS agente_log (
    id            BIGSERIAL PRIMARY KEY,
    criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
    fk_user       TEXT,
    fk_empresa    TEXT,
    session_key   TEXT,
    canal         TEXT,
    pergunta      TEXT,
    resposta      TEXT,
    ferramentas   TEXT[],           -- quais tools o agente chamou
    tokens_in     INT,
    tokens_out    INT,
    latencia_ms   INT,
    ok            BOOLEAN DEFAULT TRUE,
    erro          TEXT
);

CREATE INDEX IF NOT EXISTS idx_log_empresa_data ON agente_log (fk_empresa, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_log_user_data    ON agente_log (fk_user, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_log_erro         ON agente_log (criado_em DESC) WHERE ok = FALSE;

-- ------------------------------------------------------------
-- 3. Sessão / tenant ativo
-- ------------------------------------------------------------
-- Guarda qual fazenda o produtor multi-empresa está consultando.
-- Sem isso, quem tem 2+ fazendas fica preso na empresa padrão.
CREATE TABLE IF NOT EXISTS agente_sessao (
    session_id      TEXT PRIMARY KEY,     -- ex: "whatsapp:5548999887766"
    fk_user         TEXT NOT NULL,
    fk_empresa      TEXT NOT NULL,        -- fazenda ATIVA nesta sessão
    empresa_nome    TEXT,
    atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expira_em       TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '12 hours')
);

CREATE INDEX IF NOT EXISTS idx_sessao_expira ON agente_sessao (expira_em);

-- ------------------------------------------------------------
-- 4. Rate limit
-- ------------------------------------------------------------
-- Proteção de custo. Um produtor curioso (ou um loop de webhook mal
-- configurado) pode disparar centenas de chamadas de LLM em minutos.
CREATE TABLE IF NOT EXISTS agente_rate (
    fk_user     TEXT NOT NULL,
    janela      TIMESTAMPTZ NOT NULL,     -- início da hora (date_trunc)
    qtd         INT NOT NULL DEFAULT 1,
    PRIMARY KEY (fk_user, janela)
);

-- Incrementa e devolve a contagem da janela atual.
-- Uso no n8n (nó Postgres, Execute Query), antes do agente:
--   SELECT * FROM agente_rate_check('<fk_user>', 30);
CREATE OR REPLACE FUNCTION agente_rate_check(p_user TEXT, p_limite INT DEFAULT 30)
RETURNS TABLE (permitido BOOLEAN, usados INT, limite INT) AS $$
DECLARE
    v_janela TIMESTAMPTZ := date_trunc('hour', now());
    v_qtd    INT;
BEGIN
    INSERT INTO agente_rate (fk_user, janela, qtd)
    VALUES (p_user, v_janela, 1)
    ON CONFLICT (fk_user, janela) DO UPDATE SET qtd = agente_rate.qtd + 1
    RETURNING agente_rate.qtd INTO v_qtd;

    RETURN QUERY SELECT (v_qtd <= p_limite), v_qtd, p_limite;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------
-- 5. Cache de respostas das ferramentas
-- ------------------------------------------------------------
-- Corta tipicamente 50–70% das chamadas ao Bubble. Ver seção 4 de
-- docs/01-arquitetura.md para os TTLs sugeridos por ferramenta.
CREATE TABLE IF NOT EXISTS agente_cache (
    chave       TEXT PRIMARY KEY,          -- md5(fk_empresa | ferramenta | params)
    fk_empresa  TEXT NOT NULL,
    ferramenta  TEXT NOT NULL,
    payload     JSONB NOT NULL,
    criado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expira_em   TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cache_expira  ON agente_cache (expira_em);
CREATE INDEX IF NOT EXISTS idx_cache_empresa ON agente_cache (fk_empresa);

-- ------------------------------------------------------------
-- 6. Limpeza
-- ------------------------------------------------------------
-- Agende no n8n (cron diário 03:00) ou via pg_cron.
CREATE OR REPLACE FUNCTION agente_limpeza()
RETURNS void AS $$
BEGIN
    DELETE FROM agente_cache  WHERE expira_em < now();
    DELETE FROM agente_sessao WHERE expira_em < now();
    DELETE FROM agente_rate   WHERE janela   < now() - INTERVAL '7 days';
    DELETE FROM agente_memoria WHERE created_at < now() - INTERVAL '30 days';
    -- agente_log NÃO é apagado: é o histórico que orienta o roadmap.
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------
-- 7. Consultas úteis de operação
-- ------------------------------------------------------------

-- Perguntas em que o agente falhou ou se esquivou (candidatas a virar endpoint novo)
-- SELECT criado_em, pergunta, resposta FROM agente_log
--  WHERE ok = FALSE
--     OR resposta ILIKE '%não consigo%'
--     OR resposta ILIKE '%não encontrei%'
--     OR resposta ILIKE '%não tenho acesso%'
--  ORDER BY criado_em DESC LIMIT 100;

-- Volume por fazenda nos últimos 7 dias
-- SELECT fk_empresa, count(*) AS perguntas, count(DISTINCT fk_user) AS usuarios
--   FROM agente_log WHERE criado_em > now() - INTERVAL '7 days'
--  GROUP BY 1 ORDER BY 2 DESC;

-- Ferramentas mais usadas (mostra onde vale otimizar/cachear primeiro)
-- SELECT unnest(ferramentas) AS ferramenta, count(*)
--   FROM agente_log WHERE criado_em > now() - INTERVAL '30 days'
--  GROUP BY 1 ORDER BY 2 DESC;
