require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const http = require('http');
const { Server } = require('socket.io');

const sosRoutes = require('./routes/sos');
const requestRoutes = require('./routes/requests');
const authRoutes = require('./routes/auth');
const servicesRoutes = require('./routes/services');
const usersRoutes = require('./routes/users');
const contactRoutes = require('./routes/contacts');
const providerRoutes = require('./routes/providers');
const adminRoutes = require('./routes/admin');

const { requireAdmin } = require('./middleware/requireAdmin');

// updateProviderLocation resolves the customer server-side from the
// provider's actual accepted request, instead of trusting whatever
// customerId the client sends on the socket event — see the
// 'provider_location' handler below.
// startAssignmentSweeper escalates requests whose provider never responded,
// even if the server restarted while their 90-second timer was running.
const { updateProviderLocation, startAssignmentSweeper } = require('./services/dispatch');

const app = express();
const server = http.createServer(app);

// Socket.io for realtime
const io = new Server(server, {
  cors: { origin: '*' } 
});

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Make io accessible in routes
app.set('io', io);

// Routes
app.use('/sos', sosRoutes);
app.use('/requests', requestRoutes);
app.use('/auth', authRoutes);
app.use('/services', servicesRoutes);
app.use('/users', usersRoutes);
app.use('/contacts', contactRoutes);
app.use('/providers', providerRoutes);
app.use('/admin', requireAdmin, adminRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'i-Emergency API is running',
    timestamp: new Date(),
  });
});

// Basic sanity check for ids sent over sockets.
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64;

// Socket.io connections
io.on('connection', (socket) => {
  console.log('✅ Client connected:', socket.id);

  // Customer joins their room.
  // NOTE: the id comes from the client, so any socket can join any user's room
  // and receive their job_accepted / provider_location / no_providers events.
  // Proper fix: issue a token at OTP login, verify it in io.use(...), and join
  // rooms from the verified identity instead of from this event.
  socket.on('join_room', (userId) => {
    if (!isId(userId)) return;
    socket.join(userId);
    console.log(`👤 User ${userId} joined room`);
  });

  // Provider joins their own room (same caveat as above: job_request events,
  // which include the customer's location, are delivered to this room).
  socket.on('join_provider', (providerId) => {
    if (!isId(providerId)) return;
    socket.join(`provider_${providerId}`);
    console.log(`🔧 Provider ${providerId} joined room`);
  });

  // Provider sends location update. Delegates to updateProviderLocation()
  // (dispatch.js), which looks up the customer server-side from the
  // provider's actual 'accepted' service_requests row, so a provider's
  // location can only ever reach the customer whose request they accepted.
  // providerId is still client-supplied until sockets are authenticated.
  socket.on('provider_location', (data) => {
    if (!isId(data?.providerId) || data.latitude == null || data.longitude == null) {
      console.log('⚠️ provider_location: missing providerId/latitude/longitude, ignoring');
      return;
    }
    updateProviderLocation(data.providerId, data.latitude, data.longitude, io);
  });

  // The old 'job_accepted' socket handler is removed. It let any client push a
  // fake "provider accepted" message (with any name, phone and ETA) into any
  // customer's room. acceptRequest() in dispatch.js already emits the real
  // job_accepted event to the customer after a verified accept, so the client
  // emit was redundant and made the customer app receive it twice.

  socket.on('disconnect', () => {
    console.log('❌ Client disconnected:', socket.id);
  });
});

// A stray rejected promise would otherwise take the whole server down in the
// middle of an emergency. Log it and keep serving.
process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled promise rejection:', reason);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 i-Emergency API running on port ${PORT}`);
  console.log(`📡 Socket.io realtime enabled`);
  console.log(`🌍 Health check: http://localhost:${PORT}/health`);

  startAssignmentSweeper(io);
  console.log('⏱️  Assignment sweeper started');
});