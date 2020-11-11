const url = 'ws://localhost:5000';

const connectionOptions = {
  autoConnect: false,
  transports: ['websocket'],
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  reconnectionAttempts: 5,
  timeout: 10000,
};

const socket = io(url, connectionOptions);

export default class WebsocketClient {
  static async joinRoom(room) {
    socket.emit('room', room);
    console.log('Joined room ' + room);
  }

  static sendData(data, toClientId) {
    if (toClientId.length > 1) {
      socket.emit('data', data, toClientId);
      // console.log("Sending data " + data)
    } else {
      socket.emit('data', data);
    }
  }

  static async connect() {
    socket.open();
    console.log('Connected ' + socket.sid);
  }
}
