const express = require("express")
const cors = require("cors")
const crypto = require("crypto")

const app = express()

// --- TUS LÍNEAS ORIGINALES (INTACTAS) ---
const PORT = process.argv[2] || 4000
const COORDINATOR_URL = process.argv[3]
const PUBLIC_URL = process.argv[4]
const PULSE_INTERVAL = 2000

if (!COORDINATOR_URL || !PUBLIC_URL) {
    console.log("Uso: node index.js <PORT> <COORDINATOR_URL> <PUBLIC_URL>")
    process.exit(1)
}


const id = crypto.randomUUID()

let coordinators = [COORDINATOR_URL]

let currentIdx = 0
let lastHeartbeat = null
let status = "Iniciando..."

let retryDelay = 1000 
const MAX_RETRY_DELAY = 30000 

app.use(cors())
app.use(express.json())

const getActiveUrl = () => coordinators[currentIdx]

async function discoverBackups() {
    if (status !== "Conectado") return;
    
    try {
        const response = await fetch(`${getActiveUrl()}/status`, {
            signal: AbortSignal.timeout(3000)
        });
        
        if (!response.ok) return;
        const data = await response.json();

      
        let discoveredUrls = [];
        if (Array.isArray(data.coordinators)) discoveredUrls = data.coordinators;
        else if (Array.isArray(data.backups)) discoveredUrls = data.backups;
        else if (data.coordinator && Array.isArray(data.coordinator.all)) discoveredUrls = data.coordinator.all;

        let newFound = false;
        discoveredUrls.forEach(url => {
            if (url && typeof url === 'string' && url.startsWith('http') && !coordinators.includes(url)) {
                coordinators.push(url);
                newFound = true;
                console.log(`🔍 ¡Nuevo backup descubierto en la red!: ${url}`);
            }
        });

        if (newFound) console.log(`Red actual conocida:`, coordinators);

    } catch (error) { 

    }
}

async function register() {
    try {
        console.log(`Intentando conectar a: ${getActiveUrl()}...`)
        const response = await fetch(`${getActiveUrl()}/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: id, url: PUBLIC_URL }),
            signal: AbortSignal.timeout(3000)
        })

        if (!response.ok) throw new Error("Registro rechazado")

        console.log(`✅ Conectado a: ${getActiveUrl()}`)
        status = "Conectado"
        retryDelay = 1000 
        
        await discoverBackups();

    } catch (error) {
        handleError(error.message)
    }
}

async function sendPulse() {
    if (status !== "Conectado") return 

    try {
        const response = await fetch(`${getActiveUrl()}/pulse`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: id, url: PUBLIC_URL }),
            signal: AbortSignal.timeout(3000)
        })

        if (!response.ok) throw new Error("Servidor no responde")
        lastHeartbeat = Date.now()
        
        discoverBackups();

    } catch (error) {
        console.log(`⚠️ Pulso fallido en ${getActiveUrl()}`)
        handleError(error.message)
    }
}

function handleError(msg) {
    status = "Failover"
    
    if (currentIdx === coordinators.length - 1) {
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY)
        console.log(`🚫 Todos los nodos caídos. Reintentando en ${retryDelay / 1000}s...`)
    }

    currentIdx = (currentIdx + 1) % coordinators.length
    
    if (coordinators.length > 1) {
        console.log(`🔄 Cambiando al backup descubierto: ${getActiveUrl()}`)
    }
    
    setTimeout(register, retryDelay)
}


app.post("/change-coordinator", async (req, res) => {
    const { newCoordinatorUrl } = req.body
    if (!newCoordinatorUrl) return res.status(400).send("Falta URL")
    if (!coordinators.includes(newCoordinatorUrl)) coordinators.push(newCoordinatorUrl)
    
    currentIdx = coordinators.indexOf(newCoordinatorUrl)
    retryDelay = 1000 
    await register()
    res.json({ current: getActiveUrl() })
})

app.get("/status", (req, res) => {
    res.json({
        worker: { id, port: PORT, publicUrl: PUBLIC_URL, status, nextRetry: retryDelay / 1000 },
        coordinator: {
            current: getActiveUrl(),
            all: coordinators,
            lastHeartbeat: lastHeartbeat ? new Date(lastHeartbeat).toLocaleTimeString() : "N/A"
        }
    })
})

app.get("/", (req, res) => {
    res.send(`
    <html>
    <head>
        <title>Worker Pro</title>
        <style>
            body { font-family: 'Segoe UI', sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem; }
            .card { background: #1e293b; border-radius: 12px; padding: 1.5rem; margin-bottom: 1rem; border: 1px solid #334155; }
            .status-Conectado { color: #4ade80; border-left: 5px solid #4ade80; }
            .status-Failover { color: #fbbf24; border-left: 5px solid #fbbf24; }
            input { background: #0f172a; border: 1px solid #334155; color: white; padding: 0.5rem; border-radius: 6px; width: 250px; }
            button { background: #3b82f6; color: white; border: none; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; }
            .retry-info { font-size: 0.8rem; color: #94a3b8; }
        </style>
    </head>
    <body>
        <h1>Worker Node <small style="font-size: 0.5em; opacity: 0.5;">v4.0 (Discovery)</small></h1>
        <div id="main" class="card">
            <p><strong>Estado:</strong> <span id="st"></span></p>
            <p class="retry-info">Intervalo de reintento actual: <span id="rt"></span>s</p>
            <hr style="border: 0.5px solid #334155">
            <p><strong>Coordinador Activo:</strong> <code id="c-active"></code></p>
            <p><strong>Último Pulso:</strong> <span id="lh"></span></p>
        </div>
        <div class="card">
            <h3>Topología de Red Descubierta (Backups)</h3>
            <ul id="c-list"></ul>
            <input type="text" id="newC" placeholder="https://...">
            <button onclick="add(true)">Cambiar Ya</button>
            <button onclick="add(false)" style="background:#64748b">Forzar Añadir</button>
        </div>
        <script>
            async function refresh() {
                const r = await fetch("/status"); const d = await r.json();
                document.getElementById("st").innerText = d.worker.status;
                document.getElementById("main").className = "card status-" + d.worker.status;
                document.getElementById("rt").innerText = d.worker.nextRetry;
                document.getElementById("c-active").innerText = d.coordinator.current;
                document.getElementById("lh").innerText = d.coordinator.lastHeartbeat;
                document.getElementById("c-list").innerHTML = d.coordinator.all.map(c => \`<li>\${c}</li>\`).join("");
            }
            async function add(now) {
                const url = document.getElementById("newC").value;
                await fetch("/change-coordinator", {
                    method: "POST", headers: {"Content-Type":"application/json"},
                    body: JSON.stringify({ newCoordinatorUrl: url })
                });
                refresh();
            }
            setInterval(refresh, 1000); refresh();
        </script>
    </body></html>
    `)
})

app.listen(PORT, async () => {
    console.log(`🚀 Worker iniciado en puerto ${PORT}`)
    await register()
    setInterval(sendPulse, PULSE_INTERVAL)
})