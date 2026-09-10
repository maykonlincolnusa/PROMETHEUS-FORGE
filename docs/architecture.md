# Arquitetura — Prometheus Forge

```text
Console operacional (navegador)
        │
        ├── /api/assets ──────── inventário e telemetria de demonstração
        ├── /api/audit ───────── decisões e ações rastreáveis
        └── /api/context/* ───── proxy controlado para dados públicos
                                      ├── NOAA / NWS
                                      └── USGS
```

## Princípios

- **Humano no loop:** sinais externos e modelos só recomendam; nunca autorizam ações.
- **Menor privilégio:** os dados em `data/` não são servidos diretamente ao navegador.
- **Validação na borda:** entradas de auditoria têm formato e tamanho restritos.
- **Rastreabilidade:** cada decisão relevante pode gerar um registro no servidor.
- **Portabilidade:** a base usa Node.js nativo, sem dependências de terceiros.

## API local

| Método | Rota | Finalidade |
| --- | --- | --- |
| GET | `/api/health` | Estado do serviço |
| GET | `/api/assets` | Inventário de ativos |
| GET | `/api/audit` | Histórico de auditoria |
| POST | `/api/audit` | Registrar uma decisão ou simulação |
| GET | `/api/context/weather?area=CA` | Alertas ativos NOAA/NWS |
| GET | `/api/context/earthquakes` | Feed sísmico USGS M4.5+ |

## Próxima camada de produção

1. Banco PostgreSQL e migrações versionadas.
2. OIDC/RBAC para operador, engenheiro, aprovador e auditor.
3. Ingestão autenticada de telemetria e fila de eventos.
4. Políticas de retenção, trilha de auditoria imutável e monitoramento da própria plataforma.
