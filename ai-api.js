// ============ HUGGING FACE API AI ============
const { HfInference } = require('@huggingface/inference');

const HF_TOKEN = process.env.HF_TOKEN || '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';
const hf = new HfInference(HF_TOKEN);

// Override the AI functions
async function chatWithAI(userMessage) {
    try {
        const result = await hf.textGeneration({
            model: 'distilgpt2',
            inputs: `User: ${userMessage}\nAssistant:`,
            parameters: { max_new_tokens: 100, temperature: 0.8, do_sample: true, top_k: 50 }
        });
        let response = result.generated_text || '';
        response = response.replace(`User: ${userMessage}\nAssistant:`, '').trim();
        return response || "Got it!";
    } catch(e) {
        console.error('Chat error:', e.message);
        return "⚠️ AI error. Try again.";
    }
}

async function summarizeContent(text) {
    try {
        const result = await hf.textGeneration({
            model: 'distilgpt2',
            inputs: `Summary: ${text.substring(0, 200)}\n`,
            parameters: { max_new_tokens: 80, temperature: 0.5 }
        });
        return result.generated_text?.replace(`Summary: ${text.substring(0, 200)}\n`, '').trim() || "Summarized!";
    } catch(e) {
        return "Quick summary: " + text.substring(0, 100) + "...";
    }
}

async function getAIAdvice(topic) {
    try {
        const result = await hf.textGeneration({
            model: 'distilgpt2',
            inputs: `Advice for ${topic}:`,
            parameters: { max_new_tokens: 80, temperature: 0.7 }
        });
        return result.generated_text?.replace(`Advice for ${topic}:`, '').trim() || "Keep going!";
    } catch(e) {
        return "💡 Stay consistent and engage with your audience!";
    }
}

async function generateTitles(topic, keywords = []) {
    try {
        const result = await hf.textGeneration({
            model: 'distilgpt2',
            inputs: `Titles for ${topic}:`,
            parameters: { max_new_tokens: 80, temperature: 0.9 }
        });
        const generated = result.generated_text || '';
        const titles = generated.split('\n')
            .filter(l => l.trim().length > 5)
            .slice(0, 3)
            .map(l => l.replace(/^\d+\.\s*/, '').trim());
        return titles.length > 0 ? titles : [`${topic} - Amazing!`, `${topic} - Best Ever!`, `${topic} - Must Watch!`];
    } catch(e) {
        return [`${topic} - Best Video!`, `${topic} - Amazing!`, `${topic} - Must Watch!`];
    }
}

async function generateDescription(topic, keywords = [], title = '') {
    try {
        const result = await hf.textGeneration({
            model: 'distilgpt2',
            inputs: `Description for ${title}:`,
            parameters: { max_new_tokens: 100, temperature: 0.8 }
        });
        return result.generated_text?.replace(`Description for ${title}:`, '').trim() || `Amazing ${topic} video! Watch now! 🔥`;
    } catch(e) {
        return `🔥 Amazing ${topic} video! Subscribe for more!`;
    }
}

async function generateTags(topic, keywords = []) {
    try {
        const result = await hf.textGeneration({
            model: 'distilgpt2',
            inputs: `Tags for ${topic}:`,
            parameters: { max_new_tokens: 60, temperature: 0.7 }
        });
        const generated = result.generated_text?.replace(`Tags for ${topic}:`, '').trim() || '';
        const tags = generated.split(/\s+/).filter(t => t.startsWith('#')).slice(0, 5);
        return tags.length > 0 ? tags : [`#${topic}`, `#${topic}Video`, `#Trending`];
    } catch(e) {
        return [`#${topic}`, `#${topic}Video`, `#Trending`, `#Viral`, `#Shorts`];
    }
}

// Export to be used in index.js
module.exports = {
    chatWithAI,
    summarizeContent,
    getAIAdvice,
    generateTitles,
    generateDescription,
    generateTags
};
