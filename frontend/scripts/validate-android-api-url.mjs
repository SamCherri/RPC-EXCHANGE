const apiUrl = process.env.VITE_API_URL?.trim();

if (!apiUrl) {
  console.error('VITE_API_URL é obrigatória para gerar o aplicativo Android.');
  process.exit(1);
}

let parsedUrl;

try {
  parsedUrl = new URL(apiUrl);
} catch {
  console.error('VITE_API_URL deve ser uma URL pública válida, por exemplo https://api.exemplo.com.');
  process.exit(1);
}

const localHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '10.0.2.2']);

if (parsedUrl.protocol !== 'https:' || localHosts.has(parsedUrl.hostname)) {
  console.error('O APK exige uma VITE_API_URL pública usando HTTPS; endereços locais não funcionam para usuários finais.');
  process.exit(1);
}

console.log(`API pública validada para o build Android: ${parsedUrl.origin}`);
