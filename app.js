const folderInput = document.getElementById("folderInput");
const htmlSelector = document.getElementById("htmlSelector");
const previewWrapper = document.getElementById("previewWrapper");
const previewFrame = document.getElementById("previewFrame");
const emptyState = document.getElementById("emptyState");

const btnDesktop = document.getElementById("btnDesktop");
const btnMobile = document.getElementById("btnMobile");
const btnForceShow = document.getElementById("btnForceShow");

let uploadedFiles = new Map();
let fileBlobMap = new Map(); // Menyimpan path -> Blob URL semua file
let forceShowEnabled = false;

// Bersihkan semua Blob URL lama
function cleanupBlobs() {
  fileBlobMap.forEach((url) => URL.revokeObjectURL(url));
  fileBlobMap.clear();
}

// Normalisasi path file relatif
function resolvePath(basePath, relativePath) {
  if (!relativePath || /^(https?:|data:|blob:|#)/i.test(relativePath)) return relativePath;
  
  // Tangani format nui://nama-resource/html/...
  let cleanRel = relativePath.split("?")[0].split("#")[0];
  if (cleanRel.startsWith("nui://")) {
    const parts = cleanRel.replace("nui://", "").split("/");
    parts.shift(); // buang nama resource
    return parts.join("/");
  }

  // Tangani path yang diawali slash (misal: /img/icon.png -> relatif ke folder html)
  if (cleanRel.startsWith("/")) {
    cleanRel = cleanRel.substring(1);
  }

  const stack = basePath.split("/");
  stack.pop();

  const parts = cleanRel.split("/");
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

// Cari Blob URL yang paling cocok berdasarkan path atau nama file
function findBlobUrl(basePath, rawPath) {
  if (!rawPath || /^(https?:|data:|blob:|#)/i.test(rawPath)) return null;
  
  const resolved = resolvePath(basePath, rawPath);
  if (fileBlobMap.has(resolved)) return fileBlobMap.get(resolved);

  // Fallback: cari berdasarkan akhiran path (misal "img/apps/mail.png" cocok dengan "html/img/apps/mail.png")
  const cleanTarget = rawPath.replace(/^(\.\/|\.\.\/|\/|nui:\/\/[^/]+\/)+/, "").split("?")[0];
  for (const [storedPath, blobUrl] of fileBlobMap.entries()) {
    if (storedPath.endsWith(cleanTarget)) {
      return blobUrl;
    }
  }
  return null;
}

// Ganti url(...) di dalam file CSS
async function processCssContent(cssFile, cssPath) {
  let text = await cssFile.text();
  const urlRegex = /url\(['"]?([^'")]+)['"]?\)/g;

  return text.replace(urlRegex, (match, rawUrl) => {
    const blob = findBlobUrl(cssPath, rawUrl.trim());
    return blob ? `url("${blob}")` : match;
  });
}

// Render file HTML ke dalam iframe
async function renderHtml(htmlPath) {
  cleanupBlobs();

  // Buat Blob URL untuk semua file aset terlebih dahulu
  for (const [path, file] of uploadedFiles.entries()) {
    if (!path.endsWith(".html") && !path.endsWith(".css")) {
      fileBlobMap.set(path, URL.createObjectURL(file));
    }
  }

  const htmlFile = uploadedFiles.get(htmlPath);
  if (!htmlFile) return;

  const rawHtml = await htmlFile.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(rawHtml, "text/html");

  // 1. Proses semua tag <link rel="stylesheet">
  const links = doc.querySelectorAll('link[rel="stylesheet"]');
  for (const link of links) {
    const href = link.getAttribute("href");
    if (!href) continue;
    const resolved = resolvePath(htmlPath, href);
    const cssFile = uploadedFiles.get(resolved);

    if (cssFile) {
      const processedCss = await processCssContent(cssFile, resolved);
      const cssBlob = new Blob([processedCss], { type: "text/css" });
      const cssUrl = URL.createObjectURL(cssBlob);
      fileBlobMap.set(resolved, cssUrl);
      link.setAttribute("href", cssUrl);
    }
  }

  // 2. Proses semua tag <script src="...">
  const scripts = doc.querySelectorAll("script[src]");
  for (const script of scripts) {
    const src = script.getAttribute("src");
    const blob = findBlobUrl(htmlPath, src);
    if (blob) script.setAttribute("src", blob);
  }

  // 3. Proses semua tag media di HTML awal
  const mediaTags = doc.querySelectorAll("img[src], source[src], video[src], audio[src]");
  for (const tag of mediaTags) {
    const src = tag.getAttribute("src");
    const blob = findBlobUrl(htmlPath, src);
    if (blob) tag.setAttribute("src", blob);
  }

  // 4. Suntikkan Runtime Interceptor di paling atas <head> agar gambar dinamis & fetch JS ikut terbaca
  const blobMappingObj = Object.fromEntries(fileBlobMap);
  const interceptorScript = doc.createElement("script");
  interceptorScript.textContent = `
    (function() {
      const FILE_MAP = ${JSON.stringify(blobMappingObj)};
      const HTML_BASE = ${JSON.stringify(htmlPath)};

      function lookupAsset(rawUrl) {
        if (!rawUrl || typeof rawUrl !== "string") return rawUrl;
        if (/^(https?:|data:|blob:|#)/i.test(rawUrl)) return rawUrl;

        let clean = rawUrl.split("?")[0].split("#")[0];
        if (clean.startsWith("nui://")) {
          const parts = clean.replace("nui://", "").split("/");
          parts.shift();
          clean = parts.join("/");
        }
        clean = clean.replace(/^(\\.\\/|\\.\\.\\/|\\/)+/, "");

        // Cek exact match relatif terhadap folder HTML
        const baseDir = HTML_BASE.includes("/") ? HTML_BASE.substring(0, HTML_BASE.lastIndexOf("/") + 1) : "";
        if (FILE_MAP[baseDir + clean]) return FILE_MAP[baseDir + clean];
        if (FILE_MAP[clean]) return FILE_MAP[clean];

        // Cek suffix match
        for (const key in FILE_MAP) {
          if (key.endsWith("/" + clean) || key === clean) {
            return FILE_MAP[key];
          }
        }
        return rawUrl;
      }

      // Intercept perubahan atribut src pada elemen dinamis (img, video, audio, source)
      const origSetAttribute = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function(name, value) {
        if (name.toLowerCase() === "src" && typeof value === "string") {
          value = lookupAsset(value);
        }
        return origSetAttribute.call(this, name, value);
      };

      const imgSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
      if (imgSrcDesc && imgSrcDesc.set) {
        Object.defineProperty(HTMLImageElement.prototype, "src", {
          set: function(val) {
            imgSrcDesc.set.call(this, lookupAsset(val));
          },
          get: imgSrcDesc.get
        });
      }

      // Pantau elemen yang disuntikkan lewat innerHTML menggunakan MutationObserver
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          m.addedNodes.forEach((node) => {
            if (node.nodeType !== 1) return;
            if (node.tagName === "IMG" && node.getAttribute("src")) {
              const mapped = lookupAsset(node.getAttribute("src"));
              if (mapped !== node.getAttribute("src")) node.setAttribute("src", mapped);
            }
            node.querySelectorAll && node.querySelectorAll("img[src]").forEach((img) => {
              const raw = img.getAttribute("src");
              const mapped = lookupAsset(raw);
              if (mapped !== raw) img.setAttribute("src", mapped);
            });
          });
        }
      });
      window.addEventListener("DOMContentLoaded", () => {
        observer.observe(document.body, { childList: true, subtree: true });
      });

      // Intercept fetch() untuk file JSON/lokal dan cegah error NUI callback
      const origFetch = window.fetch;
      window.fetch = async function(input, init) {
        const url = typeof input === "string" ? input : (input && input.url);
        if (url && !url.startsWith("blob:") && !url.startsWith("data:")) {
          const mapped = lookupAsset(url);
          if (mapped !== url) {
            return origFetch(mapped, init);
          }
          // Jika fetch mengarah ke NUI callback Lua (misal https://nama-resource/getApps), kembalikan response kosong agar JS tidak crash
          if (url.startsWith("https://") && !url.includes(".")) {
            return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
          }
        }
        return origFetch(input, init);
      };
    })();
  `;
  doc.head.insertBefore(interceptorScript, doc.head.firstChild);

  // 5. Force Show UI jika diaktifkan
  if (forceShowEnabled) {
    const overrideStyle = doc.createElement("style");
    overrideStyle.textContent = `
      body, html, #app, .container, .phone, .phone-container, [style*="display: none"], [style*="display:none"] {
        display: block !important;
        opacity: 1 !important;
        visibility: visible !important;
      }
    `;
    doc.head.appendChild(overrideStyle);
  }

  const finalHtml = "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
  previewFrame.srcdoc = finalHtml;

  emptyState.classList.add("hidden");
  previewWrapper.classList.remove("hidden");
  btnForceShow.disabled = false;
}

// Event pilih folder
folderInput.addEventListener("change", (e) => {
  const files = Array.from(e.target.files);
  if (!files.length) return;

  uploadedFiles.clear();
  htmlSelector.innerHTML = "";
  const htmlFiles = [];

  files.forEach((file) => {
    const fullPath = file.webkitRelativePath;
    const relativePath = fullPath.substring(fullPath.indexOf("/") + 1);
    uploadedFiles.set(relativePath, file);

    if (relativePath.toLowerCase().endsWith(".html")) {
      htmlFiles.push(relativePath);
    }
  });

  if (htmlFiles.length === 0) {
    alert("Tidak ditemukan file .html di dalam folder yang dipilih!");
    return;
  }

  htmlFiles.sort((a, b) => {
    if (a.endsWith("index.html")) return -1;
    if (b.endsWith("index.html")) return 1;
    return a.localeCompare(b);
  });

  htmlFiles.forEach((path) => {
    const opt = document.createElement("option");
    opt.value = path;
    opt.textContent = path;
    htmlSelector.appendChild(opt);
  });

  htmlSelector.disabled = false;
  renderHtml(htmlFiles[0]);
});

htmlSelector.addEventListener("change", (e) => {
  if (e.target.value) renderHtml(e.target.value);
});

btnDesktop.addEventListener("click", () => {
  previewWrapper.className = "preview-wrapper desktop";
  btnDesktop.classList.add("active");
  btnMobile.classList.remove("active");
});

btnMobile.addEventListener("click", () => {
  previewWrapper.className = "preview-wrapper mobile";
  btnMobile.classList.add("active");
  btnDesktop.classList.remove("active");
});

btnForceShow.addEventListener("click", () => {
  forceShowEnabled = !forceShowEnabled;
  btnForceShow.classList.toggle("active", forceShowEnabled);
  if (htmlSelector.value) renderHtml(htmlSelector.value);
});
