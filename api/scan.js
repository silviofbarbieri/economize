export const config = { maxDuration: 30 };

// OpenRouter: usa Llama 3.2 Vision gratuito com fallback para o roteador free
// Compatível com OpenAI SDK — sem custo, sem cartão
const OR_MODEL = 'meta-llama/llama-3.2-11b-vision-instruct:free';
const OR_FALLBACK = 'openrouter/free'; // seleciona qualquer modelo free com visão

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'OPENROUTER_API_KEY não configurada. Crie conta gratuita em openrouter.ai, gere uma chave e adicione nas variáveis de ambiente do Vercel.'
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
- Se não for jornal de ofertas, retorne {"store":"${storeName}","products":[]}
- Responda APENAS com o JSON, nada mais`;

  // Monta o content com imagem
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

  // Tenta modelo principal, depois fallback
  const modelsToTry = [OR_MODEL, OR_FALLBACK];

  for (const model of modelsToTry) {
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

      if (!response.ok) {
        const errText = await response.text();
        let msg = `OpenRouter erro ${response.status}`;
        try { msg = JSON.parse(errText).error?.message || msg; } catch {}
        // Se for rate limit no modelo principal, tenta fallback
        if (response.status === 429 && model !== OR_FALLBACK) continue;
        return res.status(response.status).json({ error: msg });
      }

      const data = await response.json();
      const rawText = data.choices?.[0]?.message?.content || '';

      if (!rawText) {
        if (model !== OR_FALLBACK) continue;
        return res.status(422).json({ error: 'IA não retornou texto. Tente imagem mais clara e nítida.' });
      }

      let parsed;
      try {
        const clean = rawText.replace(/```json|```/g, '').trim();
        const match = clean.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(match ? match[0] : clean);
      } catch {
        if (model !== OR_FALLBACK) continue;
        return res.status(422).json({ error: 'JSON inválido na resposta. Tente imagem mais nítida.', raw: rawText.slice(0, 400) });
      }

      if (!Array.isArray(parsed.products)) parsed.products = [];
      parsed.products = parsed.products
        .filter(p => p.name && parseFloat(p.price) > 0)
        .map(p => ({ name: String(p.name).trim(), price: parseFloat(p.price) }));

      return res.status(200).json({ ...parsed, model_used: model });

    } catch (err) {
      if (model !== OR_FALLBACK) continue;
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(500).json({ error: 'Todos os modelos falharam. Tente novamente em instantes.' });
}
