export const config = { maxDuration: 30 };

// Gemini Flash — free tier: 1500 req/dia, 15 req/min
const GEMINI_MODEL = 'gemini-2.0-flash';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY não configurada. Acesse aistudio.google.com/app/apikey para obter sua chave gratuita e adicione nas variáveis de ambiente do Vercel.'
    });
  }

  const { imageData, imageType, storeName } = req.body;
  if (!imageData || !storeName) return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });

  const prompt = `Você é um extrator de dados de jornais de ofertas de supermercados brasileiros. Analise esta imagem e extraia TODOS os produtos com seus preços.

Retorne APENAS um JSON válido (sem markdown, sem texto extra) com este formato:
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
- Se não for jornal de ofertas, retorne {"store":"${storeName}","products":[]}`;

  // Monta inline_data — para URL, baixa server-side
  let inlinePart;
  if (imageType === 'url') {
    try {
      const imgResp = await fetch(imageData);
      if (!imgResp.ok) throw new Error(`HTTP ${imgResp.status}`);
      const buf = await imgResp.arrayBuffer();
      const b64 = Buffer.from(buf).toString('base64');
      const mime = imgResp.headers.get('content-type') || 'image/jpeg';
      inlinePart = { inline_data: { mime_type: mime, data: b64 } };
    } catch (e) {
      return res.status(400).json({ error: `Não foi possível baixar a imagem: ${e.message}` });
    }
  } else {
    inlinePart = { inline_data: { mime_type: 'image/jpeg', data: imageData } };
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [inlinePart, { text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      let msg = `Gemini API erro ${response.status}`;
      try { msg = JSON.parse(errText).error?.message || msg; } catch {}
      return res.status(response.status).json({ error: msg });
    }

    const data = await response.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText) return res.status(422).json({ error: 'Gemini não retornou texto. Tente imagem mais clara.' });

    let parsed;
    try {
      const clean = rawText.replace(/```json|```/g, '').trim();
      const match = clean.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(match ? match[0] : clean);
    } catch {
      return res.status(422).json({ error: 'JSON inválido na resposta da IA.', raw: rawText.slice(0, 400) });
    }

    if (!Array.isArray(parsed.products)) parsed.products = [];
    parsed.products = parsed.products
      .filter(p => p.name && parseFloat(p.price) > 0)
      .map(p => ({ name: String(p.name).trim(), price: parseFloat(p.price) }));

    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
