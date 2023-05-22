DarkWS
--------------------------------------------------

A WebSocket based protocol library

### Install
```sh
npm i darkws
```

### Usage
```ts
import {connect} from 'darkws';

const config = {
    host: 'localhost',
    path: '/ws/',
    ...
};
const ws = connect(config);

// Make request
ws.request<string>('foo:bar', {foo: 'bar'}).then((response) => {
    console.log(response);
});

// Send custom data
ws.send({message: 'Hello!'});

// Subscribe to event
ws.intercept('broadcast', (data, event) => {
    console.log(data, event);
});
ws.intercept('error', (event) => {
    console.error(event);
});
```