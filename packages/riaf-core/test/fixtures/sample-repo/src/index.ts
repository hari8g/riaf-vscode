import express from 'express';
import { OrderService } from './orderService';
import { createLogger } from './logger';

const app = express();
const logger = createLogger('api');
const orders = new OrderService(logger);

app.post('/orders', (req, res) => {
	const order = orders.createOrder(req.body);
	res.status(201).json(order);
});

app.get('/orders/:id', (req, res) => {
	res.json(orders.findOrder(req.params.id));
});

app.listen(3000, () => logger.info('listening on 3000'));
