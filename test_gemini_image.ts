import axios from 'axios';
import fs from 'fs';
import 'dotenv/config';

async function test() {
  const apiKey = process.env.GEMINI_API_KEY;
  // create a valid 1x1 png base64
  const inputBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  
  const prompt = "Given the reference garment image, generate a complete full-length product-style image. The subject must have a pure white background.";
  
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${apiKey}`,
      {
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: 'image/png',
                  data: inputBase64,
                },
              },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio: '3:4' },
        },
      },
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
    console.log(JSON.stringify(response.data, null, 2));
  } catch (err: any) {
    console.log("FAILED:");
    console.log(err.response?.data?.error?.message || err.message);
  }
}
test();
