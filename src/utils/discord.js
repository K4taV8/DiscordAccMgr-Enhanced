export { copyToClipboard, showNotification } from './clipboard.js';

export const getFriendsList = async () => {
  const result = await window.electronAPI.getFriends();
  if (!result.success) {
    throw new Error(result.error);
  }
  return result.friends || [];
};

export const getServersList = async (force = false) => {
  const result = await window.electronAPI.getServers(force);
  if (!result.success) {
    throw new Error(result.error);
  }
  return result.servers || [];
};

export const getDMsList = async () => {
  const result = await window.electronAPI.getDMs();
  if (!result.success) {
    throw new Error(result.error);
  }
  return result.dms || [];
};
