import { Logger } from './logger';
import { Order, OrderStatus } from './models/order';

/**
 * OrderService owns the lifecycle of an Order: creation, lookup and
 * payment capture. Orders are kept in memory for this sample.
 */
export class OrderService {
	private readonly orders = new Map<string, Order>();

	constructor(private readonly logger: Logger) {}

	createOrder(input: { customerId: string; amountCents: number }): Order {
		const order: Order = {
			id: `ord_${this.orders.size + 1}`,
			customerId: input.customerId,
			amountCents: input.amountCents,
			status: OrderStatus.Pending,
		};
		this.orders.set(order.id, order);
		this.logger.info(`created order ${order.id}`);
		return order;
	}

	findOrder(id: string): Order | undefined {
		return this.orders.get(id);
	}

	capturePayment(id: string): boolean {
		const order = this.orders.get(id);
		if (!order || order.status !== OrderStatus.Pending) {
			return false;
		}
		order.status = OrderStatus.Paid;
		this.logger.info(`captured payment for ${id}`);
		return true;
	}
}
