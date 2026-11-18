const folderInput = document.getElementById("folderInput");
const htmlSelector = document.getElementById("htmlSelector");
const previewWrapper = document.getElementById("previewWrapper");
const previewFrame = document.getElementById("previewFrame");
const emptyState = document.getElementById("emptyState");

const btnDesktop = document.getElementById("btnDesktop");
const btnMobile = document.getElementById("btnMobile");
const btnForceShow = document.getElementById("btnForceShow");

let uploadedFiles = new Map();
let blobUrls = [];
let forceShowEnabled = false;

// Bersihkan Blob URL lama agar memori tetap ringan
function cleanupBlobs() {
  blobUrls.forEach((url) => URL.revokeObjectURL(url));
  blobUrls = [];
}

// Normalisasi path file relatif
function resolvePath(basePath, relativePath) {
  if (/^(https?:|data:|blob:|#)/i.test(relativePath)) return relativePath;
  const cleanRel = relativePath.split("?")[0].split("#")[0];
  const stack = basePath.split("/");
  stack.pop(); // hapus nama file HTML saat ini

  const parts = cleanRel.split("/");
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

// Ganti url(...) di dalam file CSS dengan Blob URL aset gambar/font
async function processCssContent(cssFile, cssPath) {
  let text = await cssFile.text();
  const urlRegex = /url\(['"]?([^'")]+)['"]?\)/g;

  return text.replace(urlRegex, (match, rawUrl) => {
    const resolved = resolvePath(cssPath, rawUrl.trim());
    const targetFile = uploadedFiles.get(resolved);
    if (targetFile) {
      const blob = URL.createObjectURL(targetFile);
      blobUrls.push(blob);
      return `url("${blob}")`;
    }
    return match;
  });
}

// Render file HTML yang dipilih ke dalam iframe
async function renderHtml(htmlPath) {
  cleanupBlobs();
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
      blobUrls.push(cssUrl);
      link.setAttribute("href", cssUrl);
    }
  }

  // 2. Proses semua tag <script src="...">
  const scripts = doc.querySelectorAll("script[src]");
  for (const script of scripts) {
    const src = script.getAttribute("src");
    if (!src) continue;
    const resolved = resolvePath(htmlPath, src);
    const jsFile = uploadedFiles.get(resolved);

    if (jsFile) {
      const jsUrl = URL.createObjectURL(jsFile);
      blobUrls.push(jsUrl);
      script.setAttribute("src", jsUrl);
    }
  }

  // 3. Proses semua tag <img src="..."> dan <source src="...">
  const mediaTags = doc.querySelectorAll("img[src], source[src], video[src], audio[src]");
  for (const tag of mediaTags) {
    const src = tag.getAttribute("src");
    if (!src) continue;
    const resolved = resolvePath(htmlPath, src);
    const mediaFile = uploadedFiles.get(resolved);

    if (mediaFile) {
      const mediaUrl = URL.createObjectURL(mediaFile);
      blobUrls.push(mediaUrl);
      tag.setAttribute("src", mediaUrl);
    }
  }

  // 4. Jika tombol Force Show aktif, paksa elemen yang hidden agar tampil
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

// Event saat user memilih folder
folderInput.addEventListener("change", (e) => {
  const files = Array.from(e.target.files);
  if (!files.length) return;

  uploadedFiles.clear();
  htmlSelector.innerHTML = "";
  const htmlFiles = [];

  files.forEach((file) => {
    // Hilangkan nama folder root terluar agar path relatif selalu konsisten
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

  // Urutkan agar index.html muncul paling atas
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

// Ganti file HTML jika di folder ada lebih dari satu halaman
htmlSelector.addEventListener("change", (e) => {
  if (e.target.value) renderHtml(e.target.value);
});

// Switch tampilan Desktop / Phone
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

// Toggle Force Show UI
btnForceShow.addEventListener("click", () => {
  forceShowEnabled = !forceShowEnabled;
  btnForceShow.classList.toggle("active", forceShowEnabled);
  if (htmlSelector.value) renderHtml(htmlSelector.value);
});
