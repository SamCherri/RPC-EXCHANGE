# Pendência — Ícones binários do APK

Esta PR não substitui arquivos binários de ícone PNG/WebP. A alteração foi deixada como pendência separada para evitar recriação ou corrupção de binários por patch textual.

## Imagem oficial escolhida

A imagem oficial existente no repositório que deve ser usada como origem é:

- `assets/rpc_exchange_icon.png`

Motivo: é o arquivo de ícone oficial da RPC Exchange já presente no repositório, sem uso de imagem externa e sem criação de novo desenho.

## Caminhos Android que precisam ser substituídos quando o projeto Android estiver disponível

Quando o diretório Android/Capacitor for gerado ou estiver presente no repositório, substituir os binários abaixo usando a imagem oficial acima como origem:

- `frontend/android/app/src/main/res/mipmap-mdpi/ic_launcher.png`
- `frontend/android/app/src/main/res/mipmap-mdpi/ic_launcher_round.png`
- `frontend/android/app/src/main/res/mipmap-mdpi/ic_launcher_foreground.png`
- `frontend/android/app/src/main/res/mipmap-hdpi/ic_launcher.png`
- `frontend/android/app/src/main/res/mipmap-hdpi/ic_launcher_round.png`
- `frontend/android/app/src/main/res/mipmap-hdpi/ic_launcher_foreground.png`
- `frontend/android/app/src/main/res/mipmap-xhdpi/ic_launcher.png`
- `frontend/android/app/src/main/res/mipmap-xhdpi/ic_launcher_round.png`
- `frontend/android/app/src/main/res/mipmap-xhdpi/ic_launcher_foreground.png`
- `frontend/android/app/src/main/res/mipmap-xxhdpi/ic_launcher.png`
- `frontend/android/app/src/main/res/mipmap-xxhdpi/ic_launcher_round.png`
- `frontend/android/app/src/main/res/mipmap-xxhdpi/ic_launcher_foreground.png`
- `frontend/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png`
- `frontend/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.png`
- `frontend/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png`

## Caminhos web que também devem ser revisados na troca final

- `frontend/public/icons/icon-192.svg`
- `frontend/public/icons/icon-512.svg`
- `frontend/public/icons/icon-maskable.svg`
- `frontend/index.html`
- `frontend/public/manifest.webmanifest`

## Critério para concluir a pendência

1. Gerar os tamanhos oficiais por ferramenta de imagem confiável, sem distorcer nem cortar o ícone.
2. Conferir visualmente os launchers Android em mdpi, hdpi, xhdpi, xxhdpi e xxxhdpi.
3. Rodar `npm run build:android --workspace frontend` com `VITE_API_URL` HTTPS real.
4. Rodar `cap sync android` e gerar o APK em ambiente com Gradle/Android SDK funcionando.
5. Validar o APK em aparelho/emulador antes de publicar.
