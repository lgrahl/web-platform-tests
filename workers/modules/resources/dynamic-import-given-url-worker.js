// Dynamically import the script URL sent by postMessage().
onmessage = e => {
  import(e.data);
};
