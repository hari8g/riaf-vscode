export enum OrderStatus {
	Pending = 'pending',
	Paid = 'paid',
	Cancelled = 'cancelled',
}

export interface Order {
	id: string;
	customerId: string;
	amountCents: number;
	status: OrderStatus;
}

export function isOpenOrder(order: Order): boolean {
	return order.status === OrderStatus.Pending;
}
