import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function listModels() {
  try {
    // This calls the ListModels method the error suggested
    const response = await fetch(`https://generativelanguage.googleapis.com/v1/models?key=${process.env.GEMINI_API_KEY}`);
    const data = await response.json();
    console.log("AVAILABLE MODELS:", data.models.map(m => m.name));
  } catch (e) {
    console.error("Could not list models:", e);
  }
}

listModels();