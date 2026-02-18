import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import mammoth from 'mammoth';
import { fileTypeFromBuffer } from 'file-type';
import { Document, Paragraph, TextRun, HeadingLevel, Packer } from 'docx';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://resumecritic.netlify.app', 
  ],
  methods: ['GET', 'POST'],
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel(
  { model: "gemini-2.5-flash" },
  { apiVersion: 'v1' }
);

// ── Parsers ────────────────────────────────────────────────────────────────

async function extractTextFromPDF(buffer) {
  const uint8Array = new Uint8Array(buffer);
  const loadingTask = pdfjsLib.getDocument({
    data: uint8Array,
    standardFontDataUrl: path.join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts/') + '/',
  });

  const pdfDoc = await loadingTask.promise;
  let fullText = "";

  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const content = await page.getTextContent();
    fullText += content.items.map(item => item.str).join(" ") + "\n";
  }
  return fullText;
}

async function extractTextFromPDFFallback(buffer) {
  const uint8Array = new Uint8Array(buffer);
  const loadingTask = pdfjsLib.getDocument({
    data: uint8Array,
    useSystemFonts: true,
    disableFontFace: true,
  });

  const pdfDoc = await loadingTask.promise;
  let fullText = "";

  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const content = await page.getTextContent();
    fullText += content.items.map(item => item.str).join(" ") + "\n";
  }
  return fullText;
}

async function extractTextFromDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

function extractTextFromTxt(buffer) {
  return buffer.toString('utf-8');
}

// ── Main router — detects file type and calls the right parser ─────────────

async function extractText(buffer, mimeTypeHint = "") {
  const detected = await fileTypeFromBuffer(buffer);
  const mime = detected?.mime || mimeTypeHint;

  if (mime === 'application/pdf') {
    try {
      return await extractTextFromPDF(buffer);
    } catch (err) {
      if (err.message?.includes('standardFontDataUrl') || err.message?.includes('font')) {
        console.warn("Font warning, trying fallback:", err.message);
        return await extractTextFromPDFFallback(buffer);
      }
      throw err;
    }
  }

  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mime === 'application/msword'
  ) {
    return await extractTextFromDocx(buffer);
  }

  const text = extractTextFromTxt(buffer);
  if (text.trim().length > 0) return text;

  throw new Error("Unsupported file type. Please upload a PDF, DOCX, DOC, or TXT file.");
}

// ── Routes ─────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ status: "ok", message: "Resume Critic API is running" });
});

app.post('/api/analyze-resume', async (req, res) => {
  try {
    const { resumeText, mimeType } = req.body;
    if (!resumeText) {
      return res.status(400).json({ success: false, error: "No resume file provided" });
    }

    const base64Data = resumeText.includes('base64,')
      ? resumeText.split('base64,')[1]
      : resumeText;
    const buffer = Buffer.from(base64Data, 'base64');

    let extractedText = "";
    try {
      extractedText = await extractText(buffer, mimeType);
    } catch (parseErr) {
      console.error("Parsing Error:", parseErr);
      throw new Error(parseErr.message || "Could not read file content.");
    }

    if (!extractedText || extractedText.trim().length < 10) {
      throw new Error("The file appears to be empty or image-based (e.g. a scanned PDF).");
    }

    const currentDate = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const prompt = `
      You are an expert resume critic. Today's date is ${currentDate}.
      Use this date as context when evaluating timelines, employment gaps, 
      graduation dates, and experience durations. Do not assume any dates 
      are in the future if they have already passed based on today's date.
      
      Return ONLY a valid JSON object.
      Do not include markdown formatting, backticks, or the word "json".
      
      {
        "strengths": "...",
        "weaknesses": "...",
        "suggestions": "...",
        "overall": "Score /10"
      }

      Resume content:
      ${extractedText}
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    const cleanJson = text.replace(/```json|```/g, "").trim();
    const critique = JSON.parse(cleanJson);

    res.json({ success: true, critique });

  } catch (err) {
    console.error("DETAILED ERROR:", err);
    res.status(500).json({
      success: false,
      error: "AI analysis failed",
      details: err.message
    });
  }
});

app.post('/api/rewrite-resume', async (req, res) => {
  try {
    const { resumeFile, mimeType, critique } = req.body;

    if (!resumeFile || !critique) {
      return res.status(400).json({ success: false, error: "Missing resume file or critique" });
    }

    // Re-extract full text fresh from the original file — guarantees all pages are read
    let resumeContent = "";
    try {
      const base64Data = resumeFile.includes('base64,')
        ? resumeFile.split('base64,')[1]
        : resumeFile;
      const buffer = Buffer.from(base64Data, 'base64');
      resumeContent = await extractText(buffer, mimeType);
    } catch (parseErr) {
      console.error("Re-extraction Error:", parseErr);
      throw new Error("Could not re-read the resume file. Please try again.");
    }

    if (!resumeContent || resumeContent.trim().length < 10) {
      throw new Error("Could not extract enough text from the resume.");
    }

    console.log(`Extracted ${resumeContent.length} characters across all pages`); // helpful debug log

    const currentDate = new Date().toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric'
    });

    const prompt = `
      You are a professional resume editor. Today's date is ${currentDate}.
      
      Your job is to IMPROVE the resume's presentation, NOT to invent or change any factual details.
      
      STRICT RULES — you must follow these without exception:
      1. DO NOT change the person's name, email, phone number, or location
      2. DO NOT change any company names, job titles, or employment dates
      3. DO NOT change any school names, degree names, or graduation dates
      4. DO NOT add jobs, education, or certifications that are not in the original
      5. DO NOT remove any jobs, education, or certifications from the original
      6. DO NOT invent or fabricate any facts, numbers, or achievements
      7. ONLY improve the wording, grammar, and structure of what already exists
      8. ONLY add a professional summary if one does not already exist, based strictly on the existing information
      9. Bullet points should be rewritten using strong action verbs but must reflect only what is stated in the original
      10. If the original resume contains a references section, you MUST include it exactly as-is — do not omit, alter, or summarize it
      11. If the original says "References available upon request" or similar, preserve that exact phrase
      12. Include ALL sections from the original resume — do not skip any section regardless of which page it was on

      Return ONLY a valid JSON object in this exact format, no markdown, no backticks:
      {
        "name": "exact name from original",
        "email": "exact email from original",
        "phone": "exact phone from original",
        "location": "exact location from original",
        "summary": "improved or newly written summary based only on existing info",
        "experience": [
          {
            "title": "exact title from original",
            "company": "exact company from original",
            "duration": "exact duration from original",
            "bullets": ["improved wording of original bullet", "..."]
          }
        ],
        "education": [
          {
            "degree": "exact degree from original",
            "institution": "exact institution from original",
            "duration": "exact duration from original"
          }
        ],
        "skills": ["exact skills from original, no additions"],
        "certifications": ["exact certifications from original, no additions"],
        "references": [
          {
            "name": "exact referee name",
            "title": "exact referee title",
            "company": "exact referee company",
            "phone": "exact referee phone",
            "email": "exact referee email if present"
          }
        ]
      }

      Note on references: If the CV just says something like "References available upon request", 
      set references to ["Available upon request"] instead of the array of objects above.

      Original Resume (treat every detail in here as ground truth — this includes ALL pages):
      ${resumeContent}

      Critique to address (use this ONLY to improve wording and structure, not to change facts):
      Strengths: ${critique.strengths}
      Weaknesses: ${critique.weaknesses}
      Suggestions: ${critique.suggestions}
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    const cleanJson = text.replace(/```json|```/g, "").trim();
    const rewrittenResume = JSON.parse(cleanJson);

    res.json({ success: true, rewrittenResume });

  } catch (err) {
    console.error("Rewrite Error:", err);
    res.status(500).json({ success: false, error: "Rewrite failed", details: err.message });
  }
});

app.post('/api/download-resume', async (req, res) => {
  try {
    const { rewrittenResume, format } = req.body;

    if (!rewrittenResume || !format) {
      return res.status(400).json({ success: false, error: "Missing resume data or format" });
    }

    const plainText = `
${rewrittenResume.name}
${rewrittenResume.email} | ${rewrittenResume.phone} | ${rewrittenResume.location}

PROFESSIONAL SUMMARY
${rewrittenResume.summary}

EXPERIENCE
${rewrittenResume.experience.map(exp => `
${exp.title} — ${exp.company} (${exp.duration})
${exp.bullets.map(b => `• ${b}`).join('\n')}
`).join('\n')}

EDUCATION
${rewrittenResume.education.map(e => `${e.degree} — ${e.institution} (${e.duration})`).join('\n')}

SKILLS
${rewrittenResume.skills.join(', ')}

CERTIFICATIONS
${(rewrittenResume.certifications || []).join('\n')}
    `.trim();

    if (format === 'txt') {
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', 'attachment; filename="resume.txt"');
      return res.send(plainText);
    }

    if (format === 'docx' || format === 'doc') {
      const doc = new Document({
        sections: [{
          properties: {},
          children: [
            new Paragraph({ text: rewrittenResume.name, heading: HeadingLevel.TITLE }),
            new Paragraph({
              children: [new TextRun(`${rewrittenResume.email} | ${rewrittenResume.phone} | ${rewrittenResume.location}`)]
            }),
            new Paragraph({ text: "" }),

            new Paragraph({ text: "PROFESSIONAL SUMMARY", heading: HeadingLevel.HEADING_1 }),
            new Paragraph({ text: rewrittenResume.summary }),
            new Paragraph({ text: "" }),

            new Paragraph({ text: "EXPERIENCE", heading: HeadingLevel.HEADING_1 }),
            ...rewrittenResume.experience.flatMap(exp => [
              new Paragraph({
                children: [new TextRun({ text: `${exp.title} — ${exp.company}`, bold: true })]
              }),
              new Paragraph({ text: exp.duration }),
              ...exp.bullets.map(b => new Paragraph({ text: `• ${b}` })),
              new Paragraph({ text: "" }),
            ]),

            new Paragraph({ text: "EDUCATION", heading: HeadingLevel.HEADING_1 }),
            ...rewrittenResume.education.map(e =>
              new Paragraph({ text: `${e.degree} — ${e.institution} (${e.duration})` })
            ),
            new Paragraph({ text: "" }),

            new Paragraph({ text: "SKILLS", heading: HeadingLevel.HEADING_1 }),
            new Paragraph({ text: rewrittenResume.skills.join(', ') }),
            new Paragraph({ text: "" }),

            ...(rewrittenResume.certifications?.length ? [
              new Paragraph({ text: "CERTIFICATIONS", heading: HeadingLevel.HEADING_1 }),
              ...rewrittenResume.certifications.map(c => new Paragraph({ text: c })),
            ] : []),
          ]
        }]
      });

      const buffer = await Packer.toBuffer(doc);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="resume.${format}"`);
      return res.send(buffer);
    }

    if (format === 'pdf') {
      return res.json({ success: true, plainText });
    }

    res.status(400).json({ success: false, error: "Unsupported format" });

  } catch (err) {
    console.error("Download Error:", err);
    res.status(500).json({ success: false, error: "Download failed", details: err.message });
  }
});

const RENDER_URL = process.env.RENDER_URL;

if (RENDER_URL) {
  setInterval(async () => {
    try {
      await fetch(`${RENDER_URL}/api/health`);
      console.log('Keep-alive ping sent');
    } catch (err) {
      console.error('Keep-alive ping failed:', err.message);
    }
  }, 10 * 60 * 1000); // every 10 minutes
}

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});