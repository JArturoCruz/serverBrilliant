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

`BETTER_AUTH_URL` es la URL externa canónica del servidor, por ejemplo
`http://192.168.1.10:3000` en una red privada o `https://juego.ejemplo.com`
tras un proxy HTTPS. El servidor acepta conexiones a través de sus interfaces
disponibles; los clientes usan la dirección alcanzable desde su red.
Una base SQLite nueva y vacía se inicializa automáticamente al arrancar.
Las cuentas existentes se migran automáticamente para permitir el inicio de
sesión con nombre de usuario, conservando su contraseña anterior.

Para Flutter web, agrega a `CLIENT_ORIGINS` el origen exacto de la **página**
(esquema, host y puerto), por ejemplo `http://localhost:5000`. Si Flutter elige
otro puerto, actualiza el origen y reinicia el servidor. Esto habilita CORS y
la política de orígenes confiables de Better Auth; los clientes nativos no
necesitan configurar CORS. `*` permite cualquier origen y no se recomienda
para un servidor real. Una página HTTPS requiere un servidor HTTPS y el
almacenamiento seguro web requiere HTTPS o localhost.

## Desarrollo

```powershell
npm run dev
```

El servidor escucha en el puerto indicado por `PORT` (3000 por defecto). `GET /health` devuelve el estado del servicio y las rutas de autenticación están bajo `/api/auth`.
También responde al descubrimiento UDP local en el puerto 38971. Si se cambia
`DISCOVERY_PORT`, los clientes estándar no lo detectarán automáticamente y
deberán introducir la dirección manualmente.

Para conexiones desde Internet configura HTTPS con certificado válido, el
firewall y, si corresponde, el reenvío del puerto o una VPN. Una dirección
privada de la LAN no funciona desde otra red. No publiques directamente el
puerto HTTP de desarrollo ni asumas que el descubrimiento verifica la identidad
del servidor; usa únicamente servidores de confianza.

## Prueba pública con ngrok

ngrok crea un túnel HTTPS hacia este equipo; no aloja el servidor. Instala el
agente desde [ngrok](https://ngrok.com/download), obtén tu authtoken en el
[panel](https://dashboard.ngrok.com/get-started/your-authtoken) y configura el
agente en una terminal local con `ngrok config add-authtoken TU_TOKEN`. No
compartas el token. Consulta el dominio asignado en el panel de ngrok.

Primero compila la aplicación Flutter web con ese dominio como se indica en
el README del cliente. Después inicia el servidor en PowerShell, sustituyendo
el dominio de ejemplo:

```powershell
cd C:\serverbrilliant\serverBrilliant
npm.cmd run build
$env:BETTER_AUTH_URL = 'https://tu-dominio.ngrok-free.dev'
$env:CLIENT_ORIGINS = 'https://tu-dominio.ngrok-free.dev'
$env:BRILLIANT_WEB_ROOT = 'C:\brilliant\brilliant\build\web'
npm.cmd start
```

Estas variables solo afectan a esa terminal y no cambian `.env`, el secreto
ni la base de datos. Para permitir además otros orígenes web de confianza,
añádelos a `CLIENT_ORIGINS` separados por comas. Los clientes nativos no
necesitan CORS. La versión web de producción requiere HTTPS también para
conectar con otros servidores; no puede usar el HTTP de la LAN.

En otra terminal, ejecuta `ngrok http 3000 --inspect=false`; comprueba que la URL indicada
por ngrok coincide con la compilada y configurada arriba. El dominio sirve
la aplicación y las rutas de API. La advertencia gratuita de ngrok puede
requerir pulsar **Visit Site** en el navegador. Mantén ambas terminales
abiertas. `--inspect=false` evita guardar el contenido de las solicitudes en
el inspector local de ngrok. Las partidas se pierden al reiniciar el servidor.

Los PIN de seis dígitos son fáciles de adivinar. Detrás de ngrok los límites
por IP de Better Auth no son una protección fiable hasta configurar y verificar
una política de proxies de confianza; no uses cuentas sensibles ni consideres
esta configuración adecuada para producción. No habilites `*` como origen para
la exposición pública.

## Multijugador

Las rutas `/api/multiplayer` requieren el token Bearer de una sesión válida.
El lobby publica nombres y presencia solo a usuarios autenticados. Las salas
usan códigos aleatorios de seis caracteres, admiten de 2 a 6 jugadores y solo
el anfitrión puede iniciarlas. La partida y las jugadas se validan en el
servidor; el umbral depende del número de jugadores: 26, 24, 22, 20 o 18 puntos
para salas de 2 a 6.

Antes de comenzar, todos los jugadores, incluido el anfitrión, deben marcarse
como listos. Pueden retirar su confirmación; el anfitrión inicia cuando todos
están listos y conectados. Mientras la sala espera, el anfitrión puede expulsar
o bloquear a otro jugador. La tercera expulsión del mismo usuario lo bloquea
automáticamente. El bloqueo y el contador solo duran mientras exista esa sala;
las cuentas bloqueadas pueden jugar en otras salas.

Cada jugador configura y juega en su propio tablero usando las reglas del mapa
seleccionado. Todos juegan simultáneamente cada ronda con la misma tirada; los
siguientes dados se lanzan solo cuando todos completaron o saltaron esa ronda.
El servidor valida las jugadas y comparte los tableros actuales y finales solo
con los miembros autenticados de la sala.
Las recompensas de cada zona se asignan por ronda de finalización: quienes la
completan en la misma ronda comparten el mismo premio, y el siguiente premio
queda para la siguiente ronda en que alguien la complete. Los premios no se
liberan si un jugador abandona la partida.
Si nadie puede usar los dados de una ronda, se espera brevemente y se inicia
otra tirada mientras exista alguna jugada posible con otra combinación.

El cliente actualiza el lobby y la sala cada dos segundos. Si un jugador deja
de enviar latidos, aparece desconectado después de seis segundos y dispone de
60 segundos para volver; al agotarse el plazo, se elimina de la partida. Si el
anfitrión sale antes del inicio o durante la configuración, la sala se
disuelve; una vez iniciada la partida, el resto continúa jugando sin él. Se
conservan sus puntos y las recompensas de zona que ya obtuvo.
Si solo queda un jugador, gana automáticamente sin importar las puntuaciones;
puede consultar los tableros y resultados antes de confirmar su salida al lobby.
Una desconexión cuenta como abandono al agotarse el plazo de reconexión.

**Límite de despliegue:** las salas y partidas se guardan en memoria del proceso.
Un reinicio las elimina y esta versión requiere una única instancia del
servidor. Para escalar horizontalmente o conservar partidas tras reinicios,
primero debe añadirse almacenamiento compartido y coordinación entre instancias.

## Registrar un usuario desde la terminal

```powershell
npm run register
```

El comando pide un nombre de usuario único y un PIN numérico de exactamente
seis dígitos (el PIN no se muestra mientras se escribe). No es
necesario iniciar el servidor web. Usa la base de datos configurada en
`SQLITE_PATH`. Un PIN de seis dígitos ofrece protección limitada. No hay
recuperación por correo.

## Compilar y probar

```powershell
npm test
npm start
```
