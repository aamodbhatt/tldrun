import { GoogleGenAI } from '@google/genai';
import * as dotenv from 'dotenv';
dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function list() {
    const result: any = await ai.models.list();
    const raw = JSON.stringify(result);
    const json = JSON.parse(raw);

    const validModels = [];
    // `json` should act like an array or an object string. We saw it starts with `[`
    for (const model of json) {
        if (model.name && model.name.includes('gemini') && model.supportedActions?.includes('generateContent') && !model.name.includes('vision') && !model.name.includes('audio') && !model.name.includes('embedding')) {
            validModels.push(model.name.replace('models/', ''));
        }
    }
    console.log("SUPPORTED:", validModels.join(', '));
}
list().catch(console.error);
