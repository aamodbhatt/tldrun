import { GoogleGenAI } from '@google/genai';
import * as dotenv from 'dotenv';
dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function checkLimit() {
    try {
        // Try a tiny request
        console.log('Sending test request to gemini-2.5-flash to check quota...');
        const result = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: 'Respond with exactly one word: OK'
        });
        console.log('\n✅ SUCCESS: The quota is fine. (Response: ' + result.text + ')');
        console.log('If your uploads are failing, the PDF is likely too large for the Tokens-Per-Minute limit, or the prompt logic requires adjusting.');
    } catch (e: any) {
        if (e.status === 429 || String(e).includes('429') || String(e).includes('quota')) {
            console.log('\n❌ FAILURE: HTTP 429 Quota Exceeded!');
            console.log('You have hit a Rate Limit (Requests per Minute) or the Daily Hard Limit (1,500 Requests per day).');
            console.log('Raw error message:', e.message || String(e));
        } else {
            console.log('\n⚠️ OTHER ERROR:', e.message || String(e));
        }
    }
}
checkLimit().catch(console.error);
