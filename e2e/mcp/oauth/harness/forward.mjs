// TCP forwarder for a CLI run in a container: localhost:<listen> → <host>:<port>,
// so the CLI reaches the host's server at the URL the server calls itself
// (http://localhost:PORT), which OAuth binds tokens to.
import net from 'node:net'

const [listen, host, port] = process.argv.slice(2)
net.createServer((socket) => {
  const upstream = net.connect(Number(port), host)
  socket.pipe(upstream).pipe(socket)
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
}).listen(Number(listen), '127.0.0.1')
