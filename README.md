# Brilliant Auth Server

Servidor de autenticación con [Better Auth](https://www.better-auth.com/), Express y SQLite.

## Requisitos

- Node.js 24 o superior
- npm

## Configuración

```powershell
npm install
Copy-Item .env.example .env
```

Edita `.env` y configura `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET` (mínimo 32 caracteres) y `CLIENT_ORIGINS` con los orígenes permitidos, separados por comas. No publiques `.env` ni la base de datos.

## Desarrollo

```powershell
npm run dev
```

El servidor escucha en el puerto indicado por `PORT` (3000 por defecto). `GET /health` devuelve el estado del servicio y las rutas de autenticación están bajo `/api/auth`.

## Multijugador

Las rutas `/api/multiplayer` requieren el token Bearer de una sesión válida.
El lobby publica nombres y presencia solo a usuarios autenticados. Las salas
usan códigos aleatorios de seis caracteres, admiten de 2 a 6 jugadores y solo
el anfitrión puede iniciarlas. La partida y las jugadas se validan en el
servidor; el umbral depende del número de jugadores: 26, 24, 22, 20 o 18 puntos
para salas de 2 a 6.

Cada jugador configura y juega en su propio tablero usando las reglas del mapa
seleccionado. Todos juegan simultáneamente cada ronda con la misma tirada; los
siguientes dados se lanzan solo cuando todos completaron o saltaron esa ronda.
El servidor valida las jugadas y conserva privado el tablero de cada jugador.
Las recompensas de cada zona se asignan por ronda de finalización: quienes la
completan en la misma ronda comparten el mismo premio, y el siguiente premio
queda para la siguiente ronda en que alguien la complete. Los premios no se
liberan si un jugador abandona la partida.

El cliente actualiza el lobby y la sala cada dos segundos. Si un jugador deja
de enviar latidos, aparece desconectado después de seis segundos y dispone de
60 segundos para volver; al agotarse el plazo, se elimina de la partida. Si el
anfitrión sale antes del inicio o durante la configuración, la sala se
disuelve; una vez iniciada la partida, el resto continúa jugando sin él. Se
conservan sus puntos y las recompensas de zona que ya obtuvo.

**Límite de despliegue:** las salas y partidas se guardan en memoria del proceso.
Un reinicio las elimina y esta versión requiere una única instancia del
servidor. Para escalar horizontalmente o conservar partidas tras reinicios,
primero debe añadirse almacenamiento compartido y coordinación entre instancias.

## Registrar un usuario desde la terminal

```powershell
npm run register
```

El comando pide nombre, correo y contraseña (la contraseña no se muestra mientras se escribe). No es necesario iniciar el servidor web. Usa la base de datos configurada en `SQLITE_PATH`.

## Compilar y probar

```powershell
npm test
npm start
```
