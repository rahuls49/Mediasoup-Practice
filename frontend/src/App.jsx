import React, { useEffect } from 'react';
import io from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

const roomName = "testing";

const App = () => {
  let device;
  let rtpCapabilities;
  let producerTransport;
  let consumerTransports = [];
  let audioProducer;
  let videoProducer;
  // let consumer;
  // let isProducer = false;
  let audioParams;
  let videoParams;

  useEffect(() => {
    const socket = io("http://localhost:3000/mediasoup");

    socket.on('connection-success', ({ socketId }) => {
      console.log(socketId);
      getLocalStream();
    });

    const streamSuccess = (stream) => {
      document.getElementById("localVideo").srcObject = stream;
      audioParams = { track: stream.getAudioTracks()[0] };
      videoParams = { track: stream.getVideoTracks()[0] };
      console.log("audioParams", audioParams);
      console.log("videoParams", videoParams);
      joinRoom();
    };

    const joinRoom = () => {
      socket.emit('joinRoom', { roomName }, (data) => {
        console.log(`Router RTP Capabilities... ${data.rtpCapabilities}`);
        rtpCapabilities = data.rtpCapabilities;
        createDevice();
      });
    };

    const getLocalStream = () => {
      navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
          width: {
            min: 640,
            max: 1920,
          },
          height: {
            min: 400,
            max: 1080,
          }
        }
      })
      .then(streamSuccess)
      .catch(error => {
        console.log(error.message);
      });
    };

    const createDevice = async () => {
      try {
        device = new mediasoupClient.Device();
        await device.load({ routerRtpCapabilities: rtpCapabilities });
        console.log('Device RTP Capabilities', device.rtpCapabilities);
        createSendTransport();
      } catch (error) {
        console.log(error);
        if (error.name === 'UnsupportedError')
          console.warn('browser not supported');
      }
    };

    const createSendTransport = () => {
      socket.emit('createWebRtcTransport', { consumer: false }, ({ params }) => {
        if (params.error) {
          console.log(params.error);
          return;
        }
        producerTransport = device.createSendTransport(params);
        producerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
          try {
            await socket.emit('transport-connect', { dtlsParameters });
            callback();
          } catch (error) {
            errback(error);
          }
        });

        producerTransport.on('produce', async (parameters, callback, errback) => {
          console.log(parameters);
          try {
            await socket.emit('transport-produce', {
              kind: parameters.kind,
              rtpParameters: parameters.rtpParameters,
              appData: parameters.appData,
            }, ({ id, producersExist }) => {
              callback({ id });
              if (producersExist) getProducers();
            });
          } catch (error) {
            errback(error);
          }
        });
        console.log("producing transport created", producerTransport)

        connectSendTransport();
      });
    };

    const connectSendTransport = async () => {
      audioProducer = await producerTransport.produce(audioParams);
      videoProducer = await producerTransport.produce(videoParams);
      audioProducer.on('trackended', () => {
        console.log('audio track ended');
      });

      audioProducer.on('transportclose', () => {
        console.log('audio transport ended');
      });

      videoProducer.on('trackended', () => {
        console.log('video track ended');
      });

      videoProducer.on('transportclose', () => {
        console.log('video transport ended');
      });
    };

    const signalNewConsumerTransport = async (remoteProducerId) => {
      if (consumerTransports.includes(remoteProducerId)) return;
      consumerTransports.push(remoteProducerId);
      console.log("Creating new consumer transport for producer ID:", remoteProducerId);
      
      await socket.emit('createWebRtcTransport', { consumer: true }, ({ params }) => {
        if (params.error) {
          console.log("Error creating consumer transport:", params.error);
          return;
        }
        console.log("Consumer transport params:", params);
        
        let consumerTransport;
        try {
          consumerTransport = device.createRecvTransport(params);
        } catch (error) {
          console.log("Error creating recv transport:", error);
          return;
        }
    
        consumerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
          try {
            await socket.emit('transport-recv-connect', {
              dtlsParameters,
              serverConsumerTransportId: params.id,
            });
            callback();
          } catch (error) {
            errback(error);
          }
        });
    
        connectRecvTransport(consumerTransport, remoteProducerId, params.id);
      });
    };
    

    socket.on('new-producer', ({ producerId }) => signalNewConsumerTransport(producerId));

    const getProducers = () => {
      socket.emit('getProducers', producerIds => {
        console.log(producerIds);
        producerIds.forEach(signalNewConsumerTransport);
      });
    };

    const connectRecvTransport = async (consumerTransport, remoteProducerId, serverConsumerTransportId) => {
      await socket.emit('consume', {
        rtpCapabilities: device.rtpCapabilities,
        remoteProducerId,
        serverConsumerTransportId,
      }, async ({ params }) => {
        if (params.error) {
          console.log('Cannot Consume');
          return;
        }
        console.log(`Consumer Params `, params);
        const consumer = await consumerTransport.consume({
          id: params.id,
          producerId: params.producerId,
          kind: params.kind,
          rtpParameters: params.rtpParameters
        });
    
        console.log("New Consumer Created", consumer);
    
        consumerTransports = [
          ...consumerTransports,
          {
            consumerTransport,
            serverConsumerTransportId: params.id,
            producerId: remoteProducerId,
            consumer,
          },
        ];
    
        console.log("consumerTransports", consumerTransports);
    
        const newElem = document.createElement('div');
        newElem.setAttribute('id', `td-${remoteProducerId}`);
    
        if (params.kind === 'audio') {
          newElem.innerHTML = '<audio id="' + remoteProducerId + '" autoPlay></audio>';
        } else {
          newElem.setAttribute('class', 'remoteVideo');
          newElem.innerHTML = '<video id="' + remoteProducerId + '" autoPlay className="w-full h-auto bg-black" muted></video>';
        }
    
        document.getElementById("videoContainer").appendChild(newElem);
        const { track } = consumer;
        const mediaStream = new MediaStream([track]);
        document.getElementById(remoteProducerId).srcObject = mediaStream;
        console.log(document.getElementById(remoteProducerId));
        console.log("Media Stream", mediaStream);
        socket.emit('consumer-resume', { serverConsumerId: params.serverConsumerId });
      });
    };
    

    socket.on('producer-closed', ({ remoteProducerId }) => {
      const producerToClose = consumerTransports.find(transportData => transportData.producerId === remoteProducerId);
      if (producerToClose) {
        producerToClose.consumerTransport.close();
        producerToClose.consumer.close();
        consumerTransports = consumerTransports.filter(transportData => transportData.producerId !== remoteProducerId);
        const videoElement = document.getElementById(`td-${remoteProducerId}`);
        if (videoElement) document.getElementById("videoContainer").removeChild(videoElement);
      }
    });

    return () => {
      socket.disconnect();
      if (audioProducer) audioProducer.close();
      if (videoProducer) videoProducer.close();
      if (producerTransport) producerTransport.close();
      consumerTransports.forEach(({ consumerTransport }) => consumerTransport.close());
    };
  }, []);

  return (
    <div className="flex flex-col h-screen bg-gray-100">
      <div className="flex-grow flex flex-col items-center justify-center p-4">
        <div className="flex flex-wrap justify-center w-full h-full" id="videoContainer">
          <div className="w-1/2 p-2">
            <video id="localVideo" autoPlay className="w-full h-full bg-black rounded-lg" muted></video>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
