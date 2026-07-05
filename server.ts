import express from "express";
import path from "path";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import Database from "better-sqlite3";

// Load environment variables
dotenv.config();

const app = express();
const PORT = 3000;

// Lazy database connection state
let isConnected = false;
let useInMemoryFallback = false;
let db: any = null;

// In-memory sandbox repository fallback
const inMemoryComplaints: any[] = [
  {
    id: "demo-billing-1",
    name: "Alex Rivera",
    email: "alex.rivera@example.com",
    complaintText: "I was double charged for my subscription this month! Please refund the duplicate transaction of $49.00 as soon as possible.",
    category: "Billing",
    priority: "High",
    department: "Finance & Accounts",
    sentiment: "Frustrated",
    suggestedResolution: "Locate duplicate transaction ID on payment processor dashboard and execute full credit refund. Verify billing scheduler logs.",
    resolution: "Locate duplicate transaction ID on payment processor dashboard and execute full credit refund. Verify billing scheduler logs.",
    estimatedResolutionTime: "12 Hours",
    estimatedTime: "12 Hours",
    professionalReply: "Dear Alex,\n\nI sincerely apologize for the duplicate charge on your account. I have located the error and processed a refund of $49.00 back to your card. You should see the credit reflected within 3 to 5 business days.\n\nBest regards,\nResolveAI Support Team",
    confidenceScore: 98,
    status: "Pending",
    createdAt: new Date(Date.now() - 3600000 * 3).toISOString()
  },
  {
    id: "demo-tech-2",
    name: "Sarah Jenkins",
    email: "sjenkins@example.com",
    complaintText: "The main reports page has been failing to load since this morning's update. It just shows a blank white screen with a generic spinner. I need this data for my board presentation in two hours!",
    category: "Technical",
    priority: "Critical",
    department: "Engineering Ops",
    sentiment: "Negative",
    suggestedResolution: "Investigate database query timeout on the analytical reports endpoint. Redeploy previous stable frontend build as immediate countermeasure.",
    resolution: "Investigate database query timeout on the analytical reports endpoint. Redeploy previous stable frontend build as immediate countermeasure.",
    estimatedResolutionTime: "2 Hours",
    estimatedTime: "2 Hours",
    professionalReply: "Dear Sarah,\n\nWe understand the critical urgency of this presentation and deeply apologize for the disruption. Our engineers are working on a hotfix for the reports page, which will be live in less than an hour.\n\nSincerely,\nResolveAI Engineering Division",
    confidenceScore: 96,
    status: "In Progress",
    createdAt: new Date(Date.now() - 3600000 * 5).toISOString()
  }
];

function connectToDatabase() {
  if (db) return;
  
  const dbPath = process.env.SQLITE_DB_PATH || "resolveai.db";
  console.log(`[SQLite Setup] Initializing SQLite database at: ${dbPath}`);
  
  try {
    db = new Database(dbPath);
    
    // Create the complaints table if it doesn't exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS complaints (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        complaintText TEXT NOT NULL,
        category TEXT NOT NULL,
        priority TEXT NOT NULL,
        department TEXT NOT NULL,
        sentiment TEXT NOT NULL,
        suggestedResolution TEXT NOT NULL,
        resolution TEXT NOT NULL,
        estimatedResolutionTime TEXT NOT NULL,
        estimatedTime TEXT NOT NULL,
        professionalReply TEXT NOT NULL,
        confidenceScore INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('Pending', 'In Progress', 'Resolved')) DEFAULT 'Pending',
        createdAt TEXT NOT NULL
      )
    `);
    
    // Seed the database with demo complaints if it's currently empty
    const countResult = db.prepare("SELECT COUNT(*) as count FROM complaints").get() as { count: number };
    if (countResult && countResult.count === 0) {
      console.log("[SQLite Setup] Complaints table is empty. Seeding with default demo data.");
      const insertStmt = db.prepare(`
        INSERT INTO complaints (
          id, name, email, complaintText, category, priority, department, sentiment,
          suggestedResolution, resolution, estimatedResolutionTime, estimatedTime,
          professionalReply, confidenceScore, status, createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      for (const item of inMemoryComplaints) {
        insertStmt.run(
          item.id,
          item.name,
          item.email,
          item.complaintText,
          item.category,
          item.priority,
          item.department,
          item.sentiment,
          item.suggestedResolution,
          item.resolution,
          item.estimatedResolutionTime,
          item.estimatedTime,
          item.professionalReply,
          item.confidenceScore,
          item.status,
          item.createdAt
        );
      }
      console.log("[SQLite Setup] Demo data seeded successfully.");
    }
    
    isConnected = true;
    useInMemoryFallback = false;
    console.log("SQLite Connected and Initialized");
  } catch (error) {
    console.error("❌ Failed to initialize SQLite database:", error);
    useInMemoryFallback = true;
    throw error;
  }
}

// Middleware to ensure DB connection is established
const ensureDbConnected = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  try {
    connectToDatabase();
    next();
  } catch (err: any) {
    console.error("❌ Database connection failed:", err);
    res.status(500).json({ error: "Database connection failed", details: err.message });
  }
};

// Middleware for parsing JSON requests
app.use(express.json());

// Lazy-initialized Gemini client
let aiClient: GoogleGenAI | null = null;

function getAiClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "GEMINI_API_KEY is not set. Please add it in the Secrets / Settings menu in the AI Studio UI."
      );
    }
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

// API Routes

// GET /api/complaints - Returns all complaints, newest first (with support for optional queries)
app.get("/api/complaints", ensureDbConnected, async (req, res) => {
  try {
    const { q, category, priority } = req.query;

    if (useInMemoryFallback) {
      let results = [...inMemoryComplaints];
      if (q && typeof q === "string" && q.trim()) {
        const term = q.trim().toLowerCase();
        results = results.filter(c => 
          c.name.toLowerCase().includes(term) ||
          c.email.toLowerCase().includes(term) ||
          c.complaintText.toLowerCase().includes(term) ||
          (c.department && c.department.toLowerCase().includes(term))
        );
      }
      if (category && typeof category === "string" && category !== "All") {
        results = results.filter(c => c.category === category);
      }
      if (priority && typeof priority === "string" && priority !== "All") {
        results = results.filter(c => c.priority === priority);
      }
      results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return res.json(results);
    }

    let sql = "SELECT * FROM complaints";
    const conditions: string[] = [];
    const params: any[] = [];

    if (q && typeof q === "string" && q.trim()) {
      const term = `%${q.trim()}%`;
      conditions.push("(name LIKE ? OR email LIKE ? OR complaintText LIKE ? OR department LIKE ?)");
      params.push(term, term, term, term);
    }

    if (category && typeof category === "string" && category !== "All") {
      conditions.push("category = ?");
      params.push(category);
    }

    if (priority && typeof priority === "string" && priority !== "All") {
      conditions.push("priority = ?");
      params.push(priority);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY createdAt DESC";

    const stmt = db.prepare(sql);
    const complaints = stmt.all(...params);
    res.json(complaints);
  } catch (err: any) {
    console.error("Failed to retrieve complaints:", err);
    res.status(500).json({ error: "Failed to retrieve complaints", details: err.message });
  }
});

// GET /api/complaints/:id - Returns one complaint
app.get("/api/complaints/:id", ensureDbConnected, async (req, res) => {
  try {
    if (useInMemoryFallback) {
      const complaint = inMemoryComplaints.find(c => c.id === req.params.id);
      if (!complaint) {
        return res.status(404).json({ error: "Complaint not found" });
      }
      return res.json(complaint);
    }

    const stmt = db.prepare("SELECT * FROM complaints WHERE id = ?");
    const complaint = stmt.get(req.params.id);
    if (!complaint) {
      return res.status(404).json({ error: "Complaint not found" });
    }
    res.json(complaint);
  } catch (err: any) {
    console.error("Failed to retrieve complaint:", err);
    res.status(500).json({ error: "Failed to retrieve complaint", details: err.message });
  }
});

// PATCH /api/complaints/:id/status - Updates status of a complaint
app.patch("/api/complaints/:id/status", ensureDbConnected, async (req, res) => {
  const { status } = req.body;
  if (!status || !["Pending", "In Progress", "Resolved"].includes(status)) {
    return res.status(400).json({ error: "Invalid status value" });
  }

  try {
    if (useInMemoryFallback) {
      const complaint = inMemoryComplaints.find(c => c.id === req.params.id);
      if (!complaint) {
        return res.status(404).json({ error: "Complaint not found" });
      }
      complaint.status = status;
      return res.json(complaint);
    }

    const updateStmt = db.prepare("UPDATE complaints SET status = ? WHERE id = ?");
    const result = updateStmt.run(status, req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ error: "Complaint not found" });
    }

    const selectStmt = db.prepare("SELECT * FROM complaints WHERE id = ?");
    const updatedComplaint = selectStmt.get(req.params.id);
    res.json(updatedComplaint);
  } catch (err: any) {
    console.error("Failed to update status:", err);
    res.status(500).json({ error: "Failed to update status", details: err.message });
  }
});

// POST /api/complaints - Directly saves a complaint to SQLite database
app.post("/api/complaints", ensureDbConnected, async (req, res) => {
  try {
    const data = req.body;
    
    // Simple verification/validation
    if (!data.name || !data.email || !data.complaintText) {
      return res.status(400).json({ error: "name, email, and complaintText are required fields." });
    }

    const newComplaint = {
      id: data.id || crypto.randomUUID(),
      name: data.name.trim(),
      email: data.email.trim(),
      complaintText: data.complaintText.trim(),
      category: data.category || "General",
      priority: data.priority || "Medium",
      department: data.department || "Customer Support",
      sentiment: data.sentiment || "Neutral",
      suggestedResolution: data.suggestedResolution || data.resolution || "Review complaint and contact customer.",
      resolution: data.resolution || data.suggestedResolution || "Review complaint and contact customer.",
      estimatedResolutionTime: data.estimatedResolutionTime || data.estimatedTime || "48 Hours",
      estimatedTime: data.estimatedTime || data.estimatedResolutionTime || "48 Hours",
      professionalReply: data.professionalReply || `Dear ${data.name},\n\nThank you for reaching out. We have received your complaint and are looking into it.\n\nBest regards,\nResolveAI Team`,
      confidenceScore: typeof data.confidenceScore === "number" ? data.confidenceScore : 95,
      status: data.status || "Pending",
      createdAt: data.createdAt || new Date().toISOString(),
    };

    if (useInMemoryFallback) {
      console.log(`[Sandbox Mode] Preserving complaint locally in memory via direct POST. ID: ${newComplaint.id}`);
      inMemoryComplaints.unshift(newComplaint);
      return res.status(201).json(newComplaint);
    }

    console.log(`[SQLite Direct Insert] Attempting to insert new complaint via POST. ID: ${newComplaint.id}`);
    const insertStmt = db.prepare(`
      INSERT INTO complaints (
        id, name, email, complaintText, category, priority, department, sentiment,
        suggestedResolution, resolution, estimatedResolutionTime, estimatedTime,
        professionalReply, confidenceScore, status, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertStmt.run(
      newComplaint.id,
      newComplaint.name,
      newComplaint.email,
      newComplaint.complaintText,
      newComplaint.category,
      newComplaint.priority,
      newComplaint.department,
      newComplaint.sentiment,
      newComplaint.suggestedResolution,
      newComplaint.resolution,
      newComplaint.estimatedResolutionTime,
      newComplaint.estimatedTime,
      newComplaint.professionalReply,
      newComplaint.confidenceScore,
      newComplaint.status,
      newComplaint.createdAt
    );
    console.log("Complaint Saved Successfully");
    res.status(201).json(newComplaint);
  } catch (err: any) {
    console.error("❌ [SQLite Direct Insert Error] Failed to write document to SQLite:", err);
    res.status(500).json({ error: "Failed to directly save complaint", details: err.message });
  }
});

// DELETE /api/complaints/:id - Deletes one complaint
app.delete("/api/complaints/:id", ensureDbConnected, async (req, res) => {
  try {
    if (useInMemoryFallback) {
      const index = inMemoryComplaints.findIndex(c => c.id === req.params.id);
      if (index === -1) {
        return res.status(404).json({ error: "Complaint not found" });
      }
      inMemoryComplaints.splice(index, 1);
      return res.status(204).send();
    }

    const deleteStmt = db.prepare("DELETE FROM complaints WHERE id = ?");
    const result = deleteStmt.run(req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ error: "Complaint not found" });
    }
    res.status(204).send();
  } catch (err: any) {
    console.error("Failed to delete complaint:", err);
    res.status(500).json({ error: "Failed to delete complaint", details: err.message });
  }
});

// POST /api/complaints/analyze - Accepts complaint details, calls Gemini, saves and returns
app.post("/api/complaints/analyze", ensureDbConnected, async (req, res) => {
  const { name, email, complaintText, tone, language } = req.body;

  // Basic request validation
  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "Customer name is required" });
  }
  if (!email || typeof email !== "string" || !email.trim()) {
    return res.status(400).json({ error: "Customer email is required" });
  }
  if (!complaintText || typeof complaintText !== "string" || !complaintText.trim()) {
    return res.status(400).json({ error: "Complaint text is required" });
  }

  try {
    const ai = getAiClient();
    const targetTone = tone || "Empathetic";
    const targetLanguage = language || "English";

    // System instruction for Gemini to adhere strictly to rules and categories
    const systemInstruction = `You are ResolveAI, an expert automated complaint resolution AI.
Analyze customer complaints and categorize them accurately, assign a priority based on the urgency of the problem, identify customer sentiment, choose the best department, formulate actionable internal resolution steps, estimate response/fix time, and draft a polite, personalized professional email reply.

For the 'professionalReply' field:
- The tone MUST be exactly: "${targetTone}".
- The email reply MUST be drafted entirely in "${targetLanguage}".
- Keep it professional, empathetic, and constructive, addressing all customer points clearly.

Choose strictly from these allowed values for the other fields:
- category: "Billing" | "Technical" | "Account" | "Logistics" | "General"
- priority: "Low" | "Medium" | "High" | "Critical"
- sentiment: "Positive" | "Neutral" | "Negative" | "Frustrated"

Respond with raw JSON conforming strictly to the response schema.`;

    const promptText = `Analyze the following customer complaint:
Customer Name: ${name}
Customer Email: ${email}
Complaint Content: "${complaintText}"`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: promptText,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            category: {
              type: Type.STRING,
              description: "Must be exactly one of: Billing, Technical, Account, Logistics, General",
            },
            priority: {
              type: Type.STRING,
              description: "Must be exactly one of: Low, Medium, High, Critical",
            },
            department: {
              type: Type.STRING,
              description: "The name of the suggested internal department to handle this",
            },
            sentiment: {
              type: Type.STRING,
              description: "Must be exactly one of: Positive, Neutral, Negative, Frustrated",
            },
            suggestedResolution: {
              type: Type.STRING,
              description: "Actionable internal step-by-step instructions for the support agent to resolve the complaint.",
            },
            estimatedResolutionTime: {
              type: Type.STRING,
              description: "Estimated resolution time (e.g. '12 Hours', '24 Hours', '2 Days', '5 Days')",
            },
            professionalReply: {
              type: Type.STRING,
              description: "Full professional email draft to the customer addressing their concern politely.",
            },
            confidenceScore: {
              type: Type.INTEGER,
              description: "Must be an integer percentage value between 75 and 100 representing the AI confidence level in this analysis",
            },
          },
          required: [
            "category",
            "priority",
            "department",
            "sentiment",
            "suggestedResolution",
            "estimatedResolutionTime",
            "professionalReply",
            "confidenceScore",
          ],
        },
      },
    });

    const textOutput = response.text;
    if (!textOutput) {
      throw new Error("No output received from Gemini API");
    }

    // Resilience parsing: strip markdown code blocks if any
    let cleanedJson = textOutput.trim();
    if (cleanedJson.startsWith("```")) {
      cleanedJson = cleanedJson.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
    }

    const analysisResult = JSON.parse(cleanedJson);

    // Formulate final Complaint object
    const newComplaint = {
      id: crypto.randomUUID(),
      name: name.trim(),
      email: email.trim(),
      complaintText: complaintText.trim(),
      category: analysisResult.category || "General",
      priority: analysisResult.priority || "Medium",
      department: analysisResult.department || "Customer Support",
      sentiment: analysisResult.sentiment || "Neutral",
      suggestedResolution: analysisResult.suggestedResolution || "Review complaint and contact customer.",
      resolution: analysisResult.suggestedResolution || "Review complaint and contact customer.",
      estimatedResolutionTime: analysisResult.estimatedResolutionTime || "48 Hours",
      estimatedTime: analysisResult.estimatedResolutionTime || "48 Hours",
      professionalReply: analysisResult.professionalReply || `Dear ${name},\n\nThank you for reaching out. We have received your complaint and are looking into it.\n\nBest regards,\nResolveAI Team`,
      confidenceScore: typeof analysisResult.confidenceScore === "number" ? analysisResult.confidenceScore : 95,
      status: "Pending" as const,
      createdAt: new Date().toISOString(),
    };

    if (useInMemoryFallback) {
      console.log(`[Sandbox Mode] Preserving complaint locally in memory. ID: ${newComplaint.id}`);
      inMemoryComplaints.unshift(newComplaint); // Add to beginning of the array so newest shows first
      return res.status(201).json(newComplaint);
    }

    // Save to SQLite database
    console.log(`[SQLite Insert] Attempting to insert new complaint. ID: ${newComplaint.id}`);
    try {
      const insertStmt = db.prepare(`
        INSERT INTO complaints (
          id, name, email, complaintText, category, priority, department, sentiment,
          suggestedResolution, resolution, estimatedResolutionTime, estimatedTime,
          professionalReply, confidenceScore, status, createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertStmt.run(
          newComplaint.id,
          newComplaint.name,
          newComplaint.email,
          newComplaint.complaintText,
          newComplaint.category,
          newComplaint.priority,
          newComplaint.department,
          newComplaint.sentiment,
          newComplaint.suggestedResolution,
          newComplaint.resolution,
          newComplaint.estimatedResolutionTime,
          newComplaint.estimatedTime,
          newComplaint.professionalReply,
          newComplaint.confidenceScore,
          newComplaint.status,
          newComplaint.createdAt
      );
      console.log("Complaint Saved Successfully");
      res.status(201).json(newComplaint);
    } catch (insertError: any) {
      console.error("❌ [SQLite Insert Error] Failed to write document to SQLite:", insertError);
      throw insertError; // will be caught by the outer catch block
    }
  } catch (error: any) {
    console.error("Analysis failed:", error);
    res.status(500).json({
      error: "Failed to analyze complaint with AI assistant.",
      details: error.message || error,
    });
  }
});

// POST /api/complaints/:id/regenerate - Regenerates the response draft for a specific complaint with new tone/language
app.post("/api/complaints/:id/regenerate", ensureDbConnected, async (req, res) => {
  const { tone, language } = req.body;
  const { id } = req.params;

  try {
    let complaint: any = null;
    if (useInMemoryFallback) {
      complaint = inMemoryComplaints.find(c => c.id === id);
    } else {
      const stmt = db.prepare("SELECT * FROM complaints WHERE id = ?");
      complaint = stmt.get(id);
    }

    if (!complaint) {
      return res.status(404).json({ error: "Complaint not found" });
    }

    const ai = getAiClient();
    const targetTone = tone || "Empathetic";
    const targetLanguage = language || "English";

    const systemInstruction = `You are ResolveAI, an expert automated complaint resolution assistant.
Regenerate a professional customer email reply for the given customer complaint.
- The tone MUST be: "${targetTone}"
- The language of the reply email MUST be: "${targetLanguage}"
- Incorporate customer context, complaint details, and resolution parameters.
- Respond with raw JSON containing a single property 'professionalReply'.`;

    const promptText = `Customer Name: ${complaint.name}
Customer Email: ${complaint.email}
Complaint Content: "${complaint.complaintText}"
Category: ${complaint.category}
Suggested Resolution Steps: ${complaint.resolution}`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: promptText,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            professionalReply: {
              type: Type.STRING,
              description: "The newly generated full email draft in the specified tone and language.",
            }
          },
          required: ["professionalReply"]
        }
      }
    });

    const textOutput = response.text;
    if (!textOutput) {
      throw new Error("No output received from Gemini API");
    }

    let cleanedJson = textOutput.trim();
    if (cleanedJson.startsWith("```")) {
      cleanedJson = cleanedJson.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
    }

    const result = JSON.parse(cleanedJson);
    const updatedReply = result.professionalReply;

    if (useInMemoryFallback) {
      complaint.professionalReply = updatedReply;
    } else {
      const updateStmt = db.prepare("UPDATE complaints SET professionalReply = ? WHERE id = ?");
      updateStmt.run(updatedReply, id);
    }

    res.json({ id, professionalReply: updatedReply });
  } catch (error: any) {
    console.error("Regeneration failed:", error);
    res.status(500).json({
      error: "Failed to regenerate reply draft.",
      details: error.message || error,
    });
  }
});

// Configure Vite middleware / Serve client
async function startServer() {
  console.log("[Server Startup] Initializing backend server...");
  
  // Ensure SQLite connects before any API routes execute and before the server listens
  try {
    connectToDatabase();
  } catch (err) {
    console.error("❌ Pre-connection check failed on startup:", err);
  }

  if (process.env.NODE_ENV !== "production") {
    // Development Mode: Mount Vite as middleware
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production Mode: Serve static files
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`ResolveAI Server running on port ${PORT} (http://localhost:${PORT})`);
  });
}

startServer();
