// server/rooms.js
const rooms = new Map(); // code -> room

function getRoom(code) {
  return rooms.get(code);
}

function hasRoom(code) {
  return rooms.has(code);
}

function setRoom(code, room) {
  rooms.set(code, room);
}

function deleteRoom(code) {
  rooms.delete(code);
}

function allRooms() {
  return rooms;
}

module.exports = {
  getRoom,
  hasRoom,
  setRoom,
  deleteRoom,
  allRooms,
};
