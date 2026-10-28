# Frete Regional (web)

Site que pega as **8 planilhas de frete base** e o **range da loja (.geojson)** e gera, para cada planilha,
o **Modelo Retirada** e o **Modelo Entrega** só com as faixas de CEP que caem dentro do range.

**Acesse:** https://xandesheim.github.io/frete-regional/

Tudo roda no navegador: as planilhas **não são enviadas para nenhum servidor**. Só os endereços
públicos do IBGE são baixados.

## 📋 Como usar

1. **Planilhas de frete base**: arraste ou escolha as 8 planilhas (.xls, .xlsx ou .csv). O contador fica verde em `8/8`.
2. **Range da loja**: o `.geojson` com o polígono (dá para desenhar em <https://geojson.io>). Aparece uma prévia do desenho.
3. **Gerar planilhas de frete**: acompanhe a barra e o log. No fim, baixe o **ZIP** com tudo ou cada `.xls` separado.

Exemplo de range: [`data/exemplo_range_loja.geojson`](data/exemplo_range_loja.geojson).

## ⚙️ Regras

| Coluna                | Modelo 1 – Retirada | Modelo 2 – Entrega |
|-----------------------|---------------------|--------------------|
| AbsoluteMoneyCost     | **0**               | original           |
| PricePercent          | **0**               | original           |
| PriceByExtraWeight    | **0**               | original           |
| TimeCost              | **1**               | **1**              |
| Todas as outras       | original            | original           |

- As regras estão em `js/processor.js`, funções `buildModelRetirada` e `buildModelEntrega`.
- Nomes, ordem e formato das colunas originais são mantidos. `TimeCost` no formato VTEX
  (`20.00:00:00`) vira `1.00:00:00`; numérico vira `1`.
- Uma linha é mantida se a faixa `[CEP inicial, CEP final]` contém **pelo menos um** CEP que está dentro do polígono.
- Arquivos `.xls` têm limite de 65.536 linhas; se uma planilha passar disso, é dividida em `_parte1`, `_parte2`...

### Colunas reconhecidas automaticamente
| Função        | Nomes aceitos (sem diferenciar maiúsculas/espaços/_) |
|---------------|------------------------------------------------------|
| CEP inicial   | `ZipCodeStart`, `cep_inicio`, `cep_inicial`          |
| CEP final     | `ZipCodeEnd`, `cep_fim`, `cep_final`                 |
| Preços/prazo  | `AbsoluteMoneyCost`, `PricePercent`, `PriceByExtraWeight`, `TimeCost` |

Para nomes diferentes, use um `config.json` em *Avançado*, por exemplo:

```json
{ "cep_inicio": "zipcodestart", "cep_fim": "zipcodeend", "valor_minimo": "absolutemoneycost",
  "valor_kg": "pricebyextraweight", "valor_ad_valorem": "pricepercent", "prazo": "timecost" }
```

## 🌐 Base de CEPs automática (IBGE)

Fonte: **CNEFE – Censo 2022 do IBGE** (gratuita, oficial, Brasil todo), com CEP e coordenada de cada endereço.

1. A malha de municípios do IBGE vem junto com o site (`data/malha_municipios.geojson`).
2. O site descobre quais municípios o polígono da loja toca.
3. Baixa os endereços **só desses municípios** direto do IBGE e calcula 1 ponto por CEP (mediana dos endereços).
4. Guarda o resultado no navegador. Na próxima vez, essa cidade não precisa ser baixada de novo.

Tamanhos de exemplo: Joinville 6 MB (cerca de 2 s); a cidade de São Paulo 177 MB, a maior de todas.
Para baixar de novo, use *Avançado → Apagar CEPs salvos*.

Se preferir uma base própria, escolha um `.csv` (`cep, latitude, longitude`) no passo 3. Ela tem prioridade sobre o IBGE.

## 🐛 Problemas comuns

| Mensagem | Solução |
|---|---|
| "Nenhum CEP da base caiu dentro do polígono" | O GeoJSON está no lugar errado (confira no geojson.io) ou é pequeno demais. |
| Erro de conexão | A 1ª vez numa cidade precisa de internet (servidor `ftp.ibge.gov.br`). Tente de novo. |
| "O polígono toca N municípios" | O range está grande demais (limite: 80 municípios). |
| "nenhuma aba tem colunas de CEP" | Nomes de colunas diferentes → use um `config.json`. |

## 🛠️ Desenvolvimento

Site estático, sem build: HTML + JavaScript, com [SheetJS](https://sheetjs.com) (leitura/gravação de planilhas)
e [fflate](https://github.com/101arrowz/fflate) (zip). Para rodar localmente:

```powershell
python -m http.server 8000   # e abra http://localhost:8000
```

Publicado pelo GitHub Pages a partir da branch `main`.
