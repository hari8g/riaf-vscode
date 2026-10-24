import { describe, expect, it } from 'vitest';
import { OrderService } from './orderService';
import { createLogger } from './logger';

describe('OrderService', () => {
	it('creates and captures an order', () => {
		const service = new OrderService(createLogger('test'));
		const order = service.createOrder({ customerId: 'c1', amountCents: 500 });
		expect(service.capturePayment(order.id)).toBe(true);
	});
});
