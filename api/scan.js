export const config = { maxDuration: 30 };

// Ordem de tentativa: roteador automático free → modelos com visão confirmados gratuitos
const MODELS = [
  'openrouter/free',                        // seleciona automaticamente qualquer free com visão
  'google/gemma-3-12b-it:free',             // Gemma 3 12B — multimodal, gratuito
  'qwen/qwen2.5-vl-32b-instruct:free',      // Qwen 2.5 VL 32B — excelente OCR
  'mistralai/mistral-small-3.1-24b-instruct:free', // Mistral Small 3.1 — visão
  'google/gemma-3-27b-it:free',             // Gemma 3 27B — maior e mais preciso
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'OPENROUTER_API_KEY não configurada. Crie conta gratuita em openrouter.ai, vá em Keys → Create Key e adicione nas variáveis de ambiente do Vercel.'
    });
  }

  const { imageData, imageType, storeName } = req.body;
  if (!imageData || !storeName) return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });

  const prompt = `Você é um extrator de dados de jornais de ofertas de supermercados brasileiros. Analise esta imagem e extraia TODOS os produtos com seus preços.

Retorne APENAS um JSON válido (sem markdown, sem texto extra) com este formato exato:
{
  "store": "${storeName}",
  "products": [
    {"name": "Nome do Produto com quantidade/embalagem", "price": 0.00}
  ]
}

Regras:
- Inclua TODOS os produtos visíveis com preço legível
- Preço como número decimal com ponto (ex: 12.90)
- Inclua embalagem/quantidade no nome (ex: "Arroz Tio João 5kg")
- Se preço por kg, inclua "(por kg)" no nome
- Capitalize os nomes adequadamente
- Responda APENAS com o JSON, absolutamente nada mais`;

  const imageUrl = imageType === 'url'
    ? imageData
    : `data:image/jpeg;base64,${imageData}`;

  const messages = [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: imageUrl } },
      { type: 'text', text: prompt }
    ]
  }];

  let lastError = 'Todos os modelos falharam.';

  for (const model of MODELS) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://ofertaradar.vercel.app',
          'X-Title': 'OfertaRadar',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.1,
          max_tokens: 2048,
        })
      });

      const data = await response.json();

      // Erros que justificam tentar próximo modelo
      if (!response.ok) {
        const msg = data?.error?.message || `HTTP ${response.status}`;
        lastError = msg;
        console.log(`[${model}] falhou: ${msg}`);
        continue;
      }

      // Modelo retornou erro interno (ex: no endpoints)
      if (data?.error) {
        lastError = data.error.message || JSON.stringify(data.error);
        console.log(`[${model}] erro: ${lastError}`);
        continue;
      }

      const rawText = data.choices?.[0]?.message?.content || '';
      if (!rawText) { lastError = 'Resposta vazia.'; continue; }

      // Parse JSON
      let parsed;
      try {
        const clean = rawText.replace(/```json|```/g, '').trim();
        const match = clean.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(match ? match[0] : clean);
      } catch {
        lastError = 'JSON inválido na resposta.';
        continue;
      }

      // Normaliza
      if (!Array.isArray(parsed.products)) parsed.products = [];
      parsed.products = parsed.products
        .filter(p => p.name && parseFloat(p.price) > 0)
        .map(p => ({ name: String(p.name).trim(), price: parseFloat(p.price) }));

      // Sucesso!
      return res.status(200).json({ ...parsed, model_used: model });

    } catch (err) {
      lastError = err.message;
      console.log(`[${model}] exceção: ${err.message}`);
      continue;
    }
  }

  return res.status(500).json({ error: `Falha em todos os modelos. Último erro: ${lastError}` });
}
