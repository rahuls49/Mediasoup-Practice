import express from 'express';
import http from 'http';
import path from 'path';
import { Server } from 'socket.io';
import mediasoup from 'mediasoup';
import cors from 'cors';

const app = express();
const __dirname = path.resolve();

app.get('/', (req, res) => {
  res.send('Hello from mediasoup app!');
});

app.use(cors());

const httpServer = http.createServer(app);
httpServer.listen(3000, () => {
  console.log('Listening on port: 3000');
});

const io = new Server(httpServer, {
  cors: {
    origin: "http://localhost:5173", // React frontend origin
    // origin: "http://192.168.1.9:5100"
  }
});

const connections = io.of('/mediasoup');

let worker;
let rooms = {};
let peers = {};
let transports = [];
let producers = [];
let consumers = [];

const createWorker = async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 10000,
    rtcMaxPort: 20000,
  });
  console.log(`Worker PID: ${worker.pid}`);

  worker.on('died', error => {
    console.error('Mediasoup worker has died:', error);
    setTimeout(() => process.exit(1), 2000); // exit in 2 seconds
  });

  return worker;
};


createWorker().then((createdWorker) => {
  worker = createdWorker;
});

// Array of RtpCapabilities
const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 1000,
    },
  },
];

connections.on('connection', async socket => {
  console.log(socket.id);
  socket.emit('connection-success', {
    socketId: socket.id,
  });

  const removeItems = (items, socketId, type) => {
    items.forEach(item => {
      if (item.socketId === socket.id) {
        console.log(item);
        item[type].close();
      }
    });
    items = items.filter(item => item.socketId !== socket.id);

    return items;
  };

  socket.on('disconnect', () => {
    console.log('Peer disconnected');
    consumers = removeItems(consumers, socket.id, 'consumer');
    producers = removeItems(producers, socket.id, 'producer');
    transports = removeItems(transports, socket.id, 'transport');

    if (peers[socket.id]) {
      const { roomName } = peers[socket.id];
      delete peers[socket.id];

      if (rooms[roomName]) {
        rooms[roomName] = {
          router: rooms[roomName].router,
          peers: rooms[roomName].peers.filter(socketId => socketId !== socket.id)
        };
      }
    }
  });

  socket.on('joinRoom', async ({ roomName }, callback) => {
    try {
      await createRoom(roomName, socket.id);

      peers[socket.id] = {
        socket,
        roomName,
        transports: [],
        producers: [],
        consumers: [],
        peerDetails: {
          name: '',
          isAdmin: false,
        }
      };

      const router = rooms[roomName].router;
      const rtpCapabilities = router.rtpCapabilities;
      callback({ rtpCapabilities });
    } catch (error) {
      console.error('Error creating room:', error);
    }
  });

  const createRoom = async (roomName, socketId) => {
    let router;
    let peersList = [];
    if (rooms[roomName]) {
      router = rooms[roomName].router;
      peersList = rooms[roomName].peers || [];
    } else {
      router = await worker.createRouter({ mediaCodecs });
    }
    
    console.log(`Router ID: ${router.id}`, peersList.length);

    rooms[roomName] = {
      router: router,
      peers: [...peersList, socketId],
    };

    return router;
  };

  socket.on('createWebRtcTransport', async ({ consumer }, callback) => {
    try {
      const roomName = peers[socket.id].roomName;
      const router = rooms[roomName].router;
  
      const transport = await createWebRtcTransport(router);
      callback({
        params: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        }
      });
  
      addTransport(transport, roomName, consumer);
    } catch (error) {
      console.error('Error creating WebRTC transport:', error);
      callback({ params: { error: error.message } });
    }
  });
  

  const addTransport = (transport, roomName, consumer) => {
    transports = [
      ...transports,
      { socketId: socket.id, transport, roomName, consumer }
    ];

    peers[socket.id] = {
      ...peers[socket.id],
      transports: [
        ...peers[socket.id].transports,
        transport.id,
      ]
    };
  };

  const addProducer = (producer, roomName) => {
    producers = [
      ...producers,
      { socketId: socket.id, producer, roomName, }
    ];

    peers[socket.id] = {
      ...peers[socket.id],
      producers: [
        ...peers[socket.id].producers,
        producer.id,
      ]
    };
  };

  const addConsumer = (consumer, roomName) => {
    consumers = [
      ...consumers,
      { socketId: socket.id, consumer, roomName, }
    ];

    peers[socket.id] = {
      ...peers[socket.id],
      consumers: [
        ...peers[socket.id].consumers,
        consumer.id,
      ]
    };
  };

  socket.on('getProducers', callback => {
    const { roomName } = peers[socket.id];

    let producerList = [];
    producers.forEach(producerData => {
      if (producerData.socketId !== socket.id && producerData.roomName === roomName) {
        producerList = [...producerList, producerData.producer.id];
      }
    });

    callback(producerList);
  });

  const informConsumers = (roomName, socketId, id) => {
    console.log(`Just joined, id ${id} ${roomName}, ${socketId}`);
    producers.forEach(producerData => {
      if (producerData.socketId !== socketId && producerData.roomName === roomName) {
        const producerSocket = peers[producerData.socketId].socket;
        producerSocket.emit('new-producer', { producerId: id });
      }
    });
  };

  const getTransport = (socketId) => {
    const [producerTransport] = transports.filter(transport => transport.socketId === socketId && !transport.consumer);
    return producerTransport.transport;
  };

  socket.on('transport-connect', ({ dtlsParameters }) => {
    console.log('DTLS PARAMS... ', { dtlsParameters });
    getTransport(socket.id).connect({ dtlsParameters });
  });

  socket.on('transport-produce', async ({ kind, rtpParameters, appData }, callback) => {
    const producer = await getTransport(socket.id).produce({
      kind,
      rtpParameters,
    });

    const { roomName } = peers[socket.id];

    addProducer(producer, roomName);

    informConsumers(roomName, socket.id, producer.id);

    console.log('Producer ID: ', producer.id, producer.kind);

    producer.on('transportclose', () => {
      console.log('Transport for this producer closed ');
      producer.close();
    });

    callback({
      id: producer.id,
      producersExist: producers.length > 1 ? true : false
    });
  });

  socket.on('transport-recv-connect', async ({ dtlsParameters, serverConsumerTransportId }) => {
    console.log(`DTLS PARAMS: ${dtlsParameters}`);
    const consumerTransport = transports.find(transportData => (
      transportData.consumer && transportData.transport.id == serverConsumerTransportId
    )).transport;
    await consumerTransport.connect({ dtlsParameters });
  });

  socket.on('consume', async ({ rtpCapabilities, remoteProducerId, serverConsumerTransportId }, callback) => {
    try {
      const { roomName } = peers[socket.id];
      const router = rooms[roomName].router;
      let consumerTransport = transports.find(transportData => (
        transportData.consumer && transportData.transport.id === serverConsumerTransportId
      )).transport;
  
      console.log("Router Can Consume: ", router.canConsume({
        producerId: remoteProducerId,
        rtpCapabilities
      }));
  
      if (router.canConsume({
        producerId: remoteProducerId,
        rtpCapabilities
      })) {
        const consumer = await consumerTransport.consume({
          producerId: remoteProducerId,
          rtpCapabilities,
          paused: false,
        });
  
        console.log("New Consumer Created: ", consumer.id);
  
        consumer.on('transportclose', () => {
          console.log('Transport closed for consumer');
        });
  
        consumer.on('producerclose', () => {
          console.log('Producer of consumer closed');
          socket.emit('producer-closed', { remoteProducerId });
  
          consumerTransport.close([]);
          transports = transports.filter(transportData => transportData.transport.id !== consumerTransport.id);
          consumer.close();
          consumers = consumers.filter(consumerData => consumerData.consumer.id !== consumer.id);
        });
  
        addConsumer(consumer, roomName);
  
        const params = {
          id: consumer.id,
          producerId: remoteProducerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          serverConsumerId: consumer.id,
        };
  
        callback({ params });
      } else {
        throw new Error("Router cannot consume");
      }
    } catch (error) {
      console.log(error.message);
      callback({
        params: {
          error: error
        }
      });
    }
  });
  
  

  socket.on('consumer-resume', async ({ serverConsumerId }) => {
    console.log('Consumer resume', serverConsumerId);
    const { consumer } = consumers.find(consumerData => consumerData.consumer.id === serverConsumerId);
    await consumer.resume();
  });
});

const createWebRtcTransport = async (router) => {
  return new Promise(async (resolve, reject) => {
    try {
      const webRtcTransport_options = {
        listenIps: [
          {
            ip: '0.0.0.0', // replace with relevant IP address
            announcedIp: '127.0.0.1',
          }
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      };

      let transport = await router.createWebRtcTransport(webRtcTransport_options);
      console.log(`Transport ID: ${transport.id}`);

      transport.on('dtlsstatechange', dtlsState => {
        if (dtlsState === 'closed') {
          console.log('Transport DTLS state closed');
          transport.close();
        }
      });

      transport.on('close', () => {
        console.log('Transport closed');
      });

      resolve(transport);

    } catch (error) {
      console.log('Error creating WebRTC transport:', error);
      reject(error);
    }
  });
};